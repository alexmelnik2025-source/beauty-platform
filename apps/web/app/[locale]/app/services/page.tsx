'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, Sheet, Spinner } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import { currencySymbol, formatPrice } from '@/lib/time';
import type { Service, ServiceCategory, Staff, StaffPrices } from '@/lib/types';

type Category = ServiceCategory;

type ServiceRow = Service;

/** Calm, distinguishable calendar colours (dark enough for a white page). */
const PALETTE = [
  '#1F3A93',
  '#2E7D32',
  '#7A2E8E',
  '#B23A48',
  '#C77700',
  '#00796B',
  '#455A64',
  '#000000',
];

export default function ServicesPage() {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const { orgId, location } = useSession();
  const base = `/v1/organizations/${orgId}/locations/${location.id}`;
  const [services, setServices] = useState<ServiceRow[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [editing, setEditing] = useState<ServiceRow | 'new' | null>(null);
  /** Task 251: "Duplikuj" — the new-service window filled in from this service. */
  const [copyOf, setCopyOf] = useState<ServiceRow | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);
  /** Task 254: the category being renamed and its new name. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const renameLock = useSubmitLock();
  const categoryLock = useSubmitLock();

  const load = useCallback(async () => {
    try {
      const [s, c, st] = await Promise.all([
        api<ServiceRow[]>(`${base}/services`),
        api<Category[]>(`${base}/service-categories`),
        api<Staff[]>(`${base}/staff`),
      ]);
      setServices(s);
      setCategories(c);
      setStaff(st);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    if (!categoryLock.lock()) return;
    try {
      await api(`${base}/service-categories`, {
        method: 'POST',
        // Task 254: the server puts a new category at the end of the order.
        body: { name: newCategory },
      });
      setNewCategory('');
      await load();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      categoryLock.unlock();
    }
  }

  async function removeCategory(id: string) {
    try {
      await api(`${base}/service-categories/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function renameCategory(e: FormEvent) {
    e.preventDefault();
    const category = categories.find((c) => c.id === renaming?.id);
    if (!renaming || !category || !renameLock.lock()) return;
    setError('');
    try {
      await api(`${base}/service-categories/${category.id}`, {
        method: 'PATCH',
        body: { version: category.version, name: renaming.name },
      });
      setRenaming(null);
      await load();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      renameLock.unlock();
    }
  }

  /**
   * Task 254: a category one place up or down. The server takes every category once, in the
   * order of the page; clients see the price-list groups so.
   */
  async function moveCategory(index: number, by: -1 | 1) {
    const row = categories[index];
    const other = categories[index + by];
    if (!row || !other || moving) return;
    const next = categories.map((c) => (c.id === row.id ? other : c.id === other.id ? row : c));
    setCategories(next);
    setMoving(true);
    setError('');
    try {
      setCategories(
        await api<Category[]>(`${base}/service-categories/order`, {
          method: 'PUT',
          body: { categoryIds: next.map((c) => c.id) },
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
      await load();
    } finally {
      setMoving(false);
    }
  }

  if (!services) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;

  // Owner test T5: a bookable service nobody (active) performs is invisible to clients.
  const working = new Set(staff.filter((m) => m.active).map((m) => m.id));
  const unstaffed = (s: ServiceRow) => s.active && !s.staffIds.some((id) => working.has(id));

  const groups = [
    ...categories.map((c) => ({
      category: c,
      items: services.filter((s) => s.categoryId === c.id),
    })),
    { category: null, items: services.filter((s) => !s.categoryId) },
  ];

  /**
   * Task 252: a place up or down within the category. The server takes every service once,
   * in the order of the page; clients see the price list so.
   */
  async function move(items: ServiceRow[], index: number, by: -1 | 1) {
    const row = items[index];
    const other = items[index + by];
    if (!row || !other || moving) return;
    const next = groups
      .flatMap((g) => g.items)
      .map((s) => (s.id === row.id ? other : s.id === other.id ? row : s));
    setServices(next);
    setMoving(true);
    setError('');
    try {
      setServices(
        await api<ServiceRow[]>(`${base}/services/order`, {
          method: 'PUT',
          body: { serviceIds: next.map((s) => s.id) },
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
      await load();
    } finally {
      setMoving(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{t.services.title}</h1>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            setCopyOf(null);
            setEditing('new');
          }}
        >
          + {t.services.add}
        </button>
      </div>
      <div className="page">
        <ErrorBox>{error}</ErrorBox>
        {services.length === 0 ? <p className="note">{t.services.empty}</p> : null}
        {categories.length > 1 || groups.some((g) => g.items.length > 1) ? (
          <p className="small muted">{t.services.orderHint}</p>
        ) : null}
        {groups.map((g, categoryIndex) =>
          g.items.length === 0 && !g.category ? null : (
            <section key={g.category?.id ?? 'none'} className="section">
              {renaming && g.category && renaming.id === g.category.id ? (
                <form className="copy-field" onSubmit={renameCategory}>
                  <input
                    className="input"
                    aria-label={t.services.categoryName}
                    required
                    autoFocus
                    maxLength={60}
                    value={renaming.name}
                    onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                  />
                  <button className="btn btn--small" disabled={renameLock.busy}>
                    {t.common.save}
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    onClick={() => setRenaming(null)}
                  >
                    {t.common.cancel}
                  </button>
                </form>
              ) : (
                <div className="row" style={{ alignItems: 'center' }}>
                  <h2 style={{ flex: '1 1 auto' }}>{g.category?.name ?? t.services.noCategory}</h2>
                  {g.category ? (
                    <>
                      <button
                        type="button"
                        className="link-btn small"
                        style={{ flex: '0 0 auto' }}
                        onClick={() => setRenaming({ id: g.category!.id, name: g.category!.name })}
                      >
                        {t.services.renameCategory}
                      </button>
                      <button
                        type="button"
                        className="link-btn small"
                        style={{ flex: '0 0 auto' }}
                        title={t.services.deleteCategoryHint}
                        onClick={() => void removeCategory(g.category!.id)}
                      >
                        {t.services.deleteCategory}
                      </button>
                    </>
                  ) : null}
                  {g.category && categories.length > 1 ? (
                    <span className="order-btns">
                      <button
                        type="button"
                        aria-label={fill(t.team.moveUp, { name: g.category.name })}
                        disabled={moving || categoryIndex === 0}
                        onClick={() => void moveCategory(categoryIndex, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={fill(t.team.moveDown, { name: g.category.name })}
                        disabled={moving || categoryIndex === categories.length - 1}
                        onClick={() => void moveCategory(categoryIndex, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  ) : null}
                </div>
              )}
              <ul className="list">
                {g.items.map((s, index) => (
                  <li key={s.id} className={g.items.length > 1 ? 'orderable' : undefined}>
                    <button
                      type="button"
                      className="list-row"
                      onClick={() => {
                        setCopyOf(null);
                        setEditing(s);
                      }}
                    >
                      <span
                        className="swatch"
                        style={{ '--sw': s.color ?? '#000000' } as CSSProperties}
                        aria-hidden="true"
                      />
                      <span className="grow">
                        <strong>{s.name}</strong>
                        <span className="small muted">
                          {s.durationMinutes} {t.common.minutes}
                          {s.active ? '' : ` · ${t.services.hidden}`}
                        </span>
                        {unstaffed(s) ? (
                          <span className="small warn-text">{t.services.noOnePerforms}</span>
                        ) : null}
                      </span>
                      <span>{formatPrice(s.priceGrosze, location.currency, tag)}</span>
                    </button>
                    {g.items.length > 1 ? (
                      <span className="order-btns">
                        <button
                          type="button"
                          aria-label={fill(t.team.moveUp, { name: s.name })}
                          disabled={moving || index === 0}
                          onClick={() => void move(g.items, index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={fill(t.team.moveDown, { name: s.name })}
                          disabled={moving || index === g.items.length - 1}
                          onClick={() => void move(g.items, index, 1)}
                        >
                          ↓
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
        <form className="copy-field" onSubmit={addCategory}>
          <input
            className="input"
            placeholder={t.services.categoryName}
            aria-label={t.services.categoryName}
            required
            maxLength={60}
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
          />
          <button className="btn btn--quiet" disabled={categoryLock.busy}>
            {t.services.addCategory}
          </button>
        </form>
      </div>
      {editing ? (
        <ServiceSheet
          key={editing === 'new' ? `new-${copyOf?.id ?? ''}` : editing.id}
          base={base}
          service={editing === 'new' ? null : editing}
          copyOf={editing === 'new' ? copyOf : null}
          categories={categories}
          staff={staff}
          onClose={() => {
            setEditing(null);
            setCopyOf(null);
          }}
          onDuplicate={(source) => {
            setCopyOf(source);
            setEditing('new');
          }}
          onDeleted={(id) => {
            setServices((list) => list?.filter((s) => s.id !== id) ?? null);
            setEditing(null);
            void load();
          }}
          onSaved={(saved) => {
            // Show the change at once (T2), then reload for anything else that changed.
            setServices((list) =>
              list?.some((s) => s.id === saved.id)
                ? list.map((s) => (s.id === saved.id ? saved : s))
                : [...(list ?? []), saved],
            );
            setEditing(null);
            setCopyOf(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function ServiceSheet({
  base,
  service,
  copyOf,
  categories,
  staff,
  onClose,
  onSaved,
  onDeleted,
  onDuplicate,
}: {
  base: string;
  service: ServiceRow | null;
  /** Task 251: a new service, filled in from this one; nothing is created until "Zapisz". */
  copyOf: ServiceRow | null;
  categories: Category[];
  staff: Staff[];
  onClose: () => void;
  onSaved: (saved: ServiceRow) => void;
  onDeleted: (id: string) => void;
  onDuplicate: (source: ServiceRow) => void;
}) {
  const { t, locale } = useI18n();
  const { location } = useSession();
  const source = service ?? copyOf;
  const [form, setForm] = useState({
    name: copyOf
      ? fill(t.services.copyName, { name: copyOf.name }).slice(0, 100)
      : (service?.name ?? ''),
    description: source?.description ?? '',
    durationMinutes: source?.durationMinutes ?? 30,
    bufferMinutes: source?.bufferMinutes ?? 0,
    price: source ? (source.priceGrosze / 100).toFixed(2) : '',
    categoryId: source?.categoryId ?? '',
    color: source?.color ?? PALETTE[0]!,
    active: source?.active ?? true,
    wishPhotos: source?.wishPhotos ?? false,
    // A new service: everyone who takes visits performs it, until unticked (T5).
    staffIds: source?.staffIds ?? staff.filter((m) => m.active).map((m) => m.id),
  });
  /** Task 62: each specialist's own price ("" = the service's price), as typed. */
  const [ownPrices, setOwnPrices] = useState<Record<string, string>>({});
  const [hadOwnPrices, setHadOwnPrices] = useState(false);
  /** Task 70: each specialist's own duration in minutes ("" = the service's), as typed. */
  const [ownMinutes, setOwnMinutes] = useState<Record<string, string>>({});
  const [hadOwnMinutes, setHadOwnMinutes] = useState(false);
  useEffect(() => {
    if (!source) return;
    api<StaffPrices>(`${base}/staff-prices`)
      .then((res) => {
        const mine = res.prices.filter((p) => p.serviceId === source.id);
        // A copy is a new service: it has no own prices yet, only the ones typed in here.
        if (service) setHadOwnPrices(mine.length > 0);
        setOwnPrices(
          Object.fromEntries(mine.map((p) => [p.staffId, (p.priceGrosze / 100).toFixed(2)])),
        );
        const minutes = res.durations.filter((d) => d.serviceId === source.id);
        if (service) setHadOwnMinutes(minutes.length > 0);
        setOwnMinutes(
          Object.fromEntries(minutes.map((d) => [d.staffId, String(d.durationMinutes)])),
        );
      })
      .catch(() => undefined);
  }, [base, service, source]);
  // Specialists who take visits, and anyone inactive still linked (so they can be unticked).
  const choices = staff.filter((m) => m.active || form.staffIds.includes(m.id));
  const [error, setError] = useState('');
  const { busy, lock, unlock } = useSubmitLock();
  // One key per form: a repeated or retried "add" never creates a second service (T4).
  const [key] = useState(newIdempotencyKey);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Owner test T3: a service that was never used can be deleted; one with visits only hidden.
  async function remove() {
    if (!service || !lock()) return;
    setError('');
    try {
      await api(`${base}/services/${service.id}`, { method: 'DELETE' });
      onDeleted(service.id);
    } catch (err) {
      setError(errorText(t, err));
      setConfirmDelete(false);
      unlock();
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!lock()) return;
    setError('');
    const body = {
      name: form.name,
      description: form.description || null,
      durationMinutes: Number(form.durationMinutes),
      bufferMinutes: Number(form.bufferMinutes),
      priceGrosze: Math.round(Number(form.price.replace(',', '.')) * 100),
      categoryId: form.categoryId || null,
      color: form.color,
      active: form.active,
      wishPhotos: form.wishPhotos,
    };
    try {
      let saved = service
        ? await api<ServiceRow>(`${base}/services/${service.id}`, {
            method: 'PATCH',
            body: { ...body, version: service.version },
          })
        : await api<ServiceRow>(`${base}/services`, {
            method: 'POST',
            body: { ...body, staffIds: form.staffIds },
            idempotencyKey: key,
          });
      const same =
        saved.staffIds.length === form.staffIds.length &&
        form.staffIds.every((id) => saved.staffIds.includes(id));
      if (!same) {
        saved = await api<ServiceRow>(`${base}/services/${saved.id}/staff`, {
          method: 'PUT',
          body: { staffIds: form.staffIds },
        });
      }
      // Task 62: own prices of the ticked specialists; empty = the service's price.
      const prices = form.staffIds
        .filter((id) => (ownPrices[id] ?? '').trim() !== '')
        .map((id) => ({
          staffId: id,
          priceGrosze: Math.round(Number(ownPrices[id]!.replace(',', '.')) * 100),
        }));
      if (prices.length > 0 || hadOwnPrices) {
        await api(`${base}/services/${saved.id}/staff-prices`, {
          method: 'PUT',
          body: { prices },
        });
      }
      // Task 70: own durations of the ticked specialists; empty = the service's duration.
      const durations = form.staffIds
        .filter((id) => (ownMinutes[id] ?? '').trim() !== '')
        .map((id) => ({ staffId: id, durationMinutes: Number(ownMinutes[id]) }));
      if (durations.length > 0 || hadOwnMinutes) {
        await api(`${base}/services/${saved.id}/staff-durations`, {
          method: 'PUT',
          body: { durations },
        });
      }
      onSaved(saved);
    } catch (err) {
      setError(errorText(t, err));
      unlock();
    }
  }

  return (
    <Sheet
      title={service ? t.services.edit : copyOf ? t.services.copyTitle : t.services.add}
      onClose={onClose}
    >
      <form className="form" onSubmit={save}>
        <ErrorBox>{error}</ErrorBox>
        {copyOf ? (
          <p className="small muted" data-testid="service-copy-hint">
            {t.services.copyHint}
          </p>
        ) : null}
        <label className="field">
          <span>{t.services.name}</span>
          <input
            required
            maxLength={100}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <div className="row">
          <label className="field">
            <span>{t.services.duration}</span>
            <input
              type="number"
              min={5}
              max={480}
              step={5}
              required
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>
              {fill(t.services.price, {
                currency: currencySymbol(location.currency, LOCALE_TAGS[locale]),
              })}
            </span>
            <input
              inputMode="decimal"
              required
              pattern="\d+([.,]\d{1,2})?"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>{t.services.buffer}</span>
          <input
            type="number"
            min={0}
            max={120}
            step={5}
            value={form.bufferMinutes}
            onChange={(e) => setForm({ ...form, bufferMinutes: Number(e.target.value) })}
          />
          <small className="muted">{t.services.bufferHint}</small>
        </label>
        <label className="field">
          <span>{t.services.category}</span>
          <select
            value={form.categoryId}
            onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
          >
            <option value="">{t.services.noCategory}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>{t.services.color}</span>
          <div className="swatches" role="group" aria-label={t.services.color}>
            {PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={form.color === color}
                style={{ '--sw': color } as CSSProperties}
                onClick={() => setForm({ ...form, color })}
              />
            ))}
          </div>
        </div>
        <label className="field">
          <span>
            {t.services.description} ({t.common.optional})
          </span>
          <textarea
            maxLength={500}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          <span>{t.services.active}</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.wishPhotos}
            onChange={(e) => setForm({ ...form, wishPhotos: e.target.checked })}
          />
          <span>
            {t.wishes.photosAsk}
            <span className="small muted" style={{ display: 'block' }}>
              {t.wishes.photosAskHint}
            </span>
          </span>
        </label>
        <fieldset className="section" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>
            <h3>{t.services.whoPerforms}</h3>
          </legend>
          {choices.length === 0 ? (
            <p className="small warn-text">{t.services.noStaffYet}</p>
          ) : (
            <>
              {choices.map((m) => (
                <label key={m.id} className="check">
                  <input
                    type="checkbox"
                    checked={form.staffIds.includes(m.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        staffIds: e.target.checked
                          ? [...form.staffIds, m.id]
                          : form.staffIds.filter((id) => id !== m.id),
                      })
                    }
                  />
                  <span className="grow">{m.displayName}</span>
                  {form.staffIds.includes(m.id) ? (
                    <input
                      className="input staff-price"
                      inputMode="decimal"
                      pattern="[0-9]+([.,][0-9]{1,2})?"
                      aria-label={fill(t.services.staffPrice, { name: m.displayName })}
                      placeholder={form.price || '0.00'}
                      value={ownPrices[m.id] ?? ''}
                      onChange={(e) => setOwnPrices({ ...ownPrices, [m.id]: e.target.value })}
                    />
                  ) : null}
                  {form.staffIds.includes(m.id) ? (
                    <input
                      className="input staff-minutes"
                      type="number"
                      min={5}
                      max={480}
                      step={5}
                      aria-label={fill(t.services.staffMinutes, { name: m.displayName })}
                      placeholder={String(form.durationMinutes || 30)}
                      value={ownMinutes[m.id] ?? ''}
                      onChange={(e) => setOwnMinutes({ ...ownMinutes, [m.id]: e.target.value })}
                    />
                  ) : null}
                </label>
              ))}
              <small className="muted">{t.services.staffPriceHint}</small>
              <small className={form.staffIds.length === 0 ? 'warn-text' : 'muted'}>
                {form.staffIds.length === 0 ? t.services.noOnePerforms : t.services.whoPerformsHint}
              </small>
            </>
          )}
        </fieldset>
        <button className="btn btn--block" disabled={busy}>
          {t.common.save}
        </button>
        {service ? (
          confirmDelete ? (
            <div className="stack" style={{ gap: 8 }} role="group" aria-label={t.services.delete}>
              <p className="small">{t.services.deleteConfirm}</p>
              <div className="row">
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t.services.deleteYes}
                </button>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => setConfirmDelete(false)}
                >
                  {t.services.deleteNo}
                </button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button
                type="button"
                className="link-btn small"
                disabled={busy}
                onClick={() => onDuplicate(service)}
              >
                {t.services.duplicate}
              </button>
              <button
                type="button"
                className="link-btn small"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                {t.services.delete}
              </button>
            </div>
          )
        ) : null}
      </form>
    </Sheet>
  );
}
