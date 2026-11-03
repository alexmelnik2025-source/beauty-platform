'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, Sheet, Spinner } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { useSubmitLock } from '@/lib/submit-lock';
import { formatPrice } from '@/lib/time';
import type { Service, ServiceCategory, Staff } from '@/lib/types';

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
  const [newCategory, setNewCategory] = useState('');
  const [error, setError] = useState('');
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
        body: { name: newCategory, sortOrder: categories.length },
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

  return (
    <>
      <div className="page-head">
        <h1>{t.services.title}</h1>
        <button type="button" className="btn btn--small" onClick={() => setEditing('new')}>
          + {t.services.add}
        </button>
      </div>
      <div className="page">
        <ErrorBox>{error}</ErrorBox>
        {services.length === 0 ? <p className="note">{t.services.empty}</p> : null}
        {groups.map((g) =>
          g.items.length === 0 && !g.category ? null : (
            <section key={g.category?.id ?? 'none'} className="section">
              <div className="row" style={{ alignItems: 'center' }}>
                <h2 style={{ flex: '1 1 auto' }}>{g.category?.name ?? t.services.noCategory}</h2>
                {g.category ? (
                  <button
                    type="button"
                    className="link-btn small"
                    style={{ flex: '0 0 auto' }}
                    title={t.services.deleteCategoryHint}
                    onClick={() => void removeCategory(g.category!.id)}
                  >
                    {t.services.deleteCategory}
                  </button>
                ) : null}
              </div>
              <ul className="list">
                {g.items.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="list-row" onClick={() => setEditing(s)}>
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
                      <span>{formatPrice(s.priceGrosze, tag)}</span>
                    </button>
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
          base={base}
          service={editing === 'new' ? null : editing}
          categories={categories}
          staff={staff}
          onClose={() => setEditing(null)}
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
  categories,
  staff,
  onClose,
  onSaved,
  onDeleted,
}: {
  base: string;
  service: ServiceRow | null;
  categories: Category[];
  staff: Staff[];
  onClose: () => void;
  onSaved: (saved: ServiceRow) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: service?.name ?? '',
    description: service?.description ?? '',
    durationMinutes: service?.durationMinutes ?? 30,
    bufferMinutes: service?.bufferMinutes ?? 0,
    price: service ? (service.priceGrosze / 100).toFixed(2) : '',
    categoryId: service?.categoryId ?? '',
    color: service?.color ?? PALETTE[0]!,
    active: service?.active ?? true,
    // A new service: everyone who takes visits performs it, until unticked (T5).
    staffIds: service?.staffIds ?? staff.filter((m) => m.active).map((m) => m.id),
  });
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
      onSaved(saved);
    } catch (err) {
      setError(errorText(t, err));
      unlock();
    }
  }

  return (
    <Sheet title={service ? t.services.edit : t.services.add} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <ErrorBox>{error}</ErrorBox>
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
            <span>{t.services.price}</span>
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
                  <span>{m.displayName}</span>
                </label>
              ))}
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
            <button
              type="button"
              className="link-btn small"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              {t.services.delete}
            </button>
          )
        ) : null}
      </form>
    </Sheet>
  );
}
