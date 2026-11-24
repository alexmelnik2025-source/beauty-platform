'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { ProductsSection } from '@/components/products/ProductsSection';
import { useSession } from '@/components/Session';
import { ErrorBox, FieldError, Sheet, Spinner } from '@/components/ui';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
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
  /** Task Q6: search and filters over the list, as in "Mój sklep"; "?" opens the order hint. */
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'hidden' | 'noOne'>('all');
  const [helpOpen, setHelpOpen] = useState(false);
  /** Task 251: "Duplikuj" — the new-service window filled in from this service. */
  const [copyOf, setCopyOf] = useState<ServiceRow | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [error, setError] = useState('');
  /**
   * Task 779 (owner's rule: errors where the action is): a refused "Usuń kategorię" or ↑/↓ is
   * said under that category's heading or that service's row, not as a box at the top of the page.
   * `id` is `cat:<id>` or `svc:<id>`.
   */
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const rowErrorId = (id: string) => `services-${id.replace(':', '-')}-error`;
  const rowErrorText = (id: string) => (rowError?.id === id ? rowError.text : undefined);
  const describedBy = (id: string) => (rowError?.id === id ? rowErrorId(id) : undefined);
  const [moving, setMoving] = useState(false);
  /** Task 254: the category being renamed and its new name. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const renameLock = useSubmitLock();
  const categoryLock = useSubmitLock();
  /**
   * Task 700: an empty name of a new or renamed category, or the server's answer about it, is
   * said under that field — not in the browser's bubble or a line at the top of the page.
   */
  const [categoryProblem, setCategoryProblem] = useState<{
    form: 'add' | 'rename';
    text: string;
  } | null>(null);

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

  const categoryInvalid = (form: 'add' | 'rename') => ({
    'aria-invalid': categoryProblem?.form === form || undefined,
    'aria-describedby': categoryProblem?.form === form ? `category-${form}-error` : undefined,
  });

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    if (!newCategory.trim()) {
      setCategoryProblem({ form: 'add', text: t.onboarding.fieldRequired });
      document.getElementById('category-add-name')?.focus();
      return;
    }
    if (!categoryLock.lock()) return;
    setCategoryProblem(null);
    try {
      await api(`${base}/service-categories`, {
        method: 'POST',
        // Task 254: the server puts a new category at the end of the order.
        body: { name: newCategory },
      });
      setNewCategory('');
      await load();
    } catch (err) {
      setCategoryProblem({ form: 'add', text: errorText(t, err) });
      document.getElementById('category-add-name')?.focus();
    } finally {
      categoryLock.unlock();
    }
  }

  async function removeCategory(id: string) {
    setRowError(null);
    try {
      await api(`${base}/service-categories/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setRowError({ id: `cat:${id}`, text: errorText(t, err) });
    }
  }

  async function renameCategory(e: FormEvent) {
    e.preventDefault();
    const category = categories.find((c) => c.id === renaming?.id);
    if (!renaming || !category) return;
    if (!renaming.name.trim()) {
      setCategoryProblem({ form: 'rename', text: t.onboarding.fieldRequired });
      document.getElementById('category-rename-name')?.focus();
      return;
    }
    if (!renameLock.lock()) return;
    setError('');
    setCategoryProblem(null);
    try {
      await api(`${base}/service-categories/${category.id}`, {
        method: 'PATCH',
        body: { version: category.version, name: renaming.name },
      });
      setRenaming(null);
      await load();
    } catch (err) {
      setCategoryProblem({ form: 'rename', text: errorText(t, err) });
      document.getElementById('category-rename-name')?.focus();
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
    setRowError(null);
    try {
      setCategories(
        await api<Category[]>(`${base}/service-categories/order`, {
          method: 'PUT',
          body: { categoryIds: next.map((c) => c.id) },
        }),
      );
    } catch (err) {
      setRowError({ id: `cat:${row.id}`, text: errorText(t, err) });
      await load();
    } finally {
      setMoving(false);
    }
  }

  if (!services) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;

  // Owner test T5: a bookable service nobody (active) performs is invisible to clients.
  const working = new Set(staff.filter((m) => m.active).map((m) => m.id));
  const unstaffed = (s: ServiceRow) => s.active && !s.staffIds.some((id) => working.has(id));

  const allGroups = [
    ...categories.map((c) => ({
      category: c,
      items: services.filter((s) => s.categoryId === c.id),
    })),
    { category: null, items: services.filter((s) => !s.categoryId) },
  ];
  const words = filterText.trim().toLowerCase();
  const filtering = filter !== 'all' || words !== '';
  const matches = (s: ServiceRow) =>
    (filter === 'all' ||
      (filter === 'active' && s.active) ||
      (filter === 'hidden' && !s.active) ||
      (filter === 'noOne' && unstaffed(s))) &&
    (!words || s.name.toLowerCase().includes(words));
  const counts = {
    all: services.length,
    active: services.filter((s) => s.active).length,
    hidden: services.filter((s) => !s.active).length,
    noOne: services.filter(unstaffed).length,
  };
  // While a filter or search is on, only matching services show and the arrows are hidden.
  const groups = filtering
    ? allGroups
        .map((g) => ({ ...g, items: g.items.filter(matches) }))
        .filter((g) => g.items.length > 0)
    : allGroups;

  /**
   * Task 252: a place up or down within the category. The server takes every service once,
   * in the order of the page; clients see the price list so.
   */
  async function move(items: ServiceRow[], index: number, by: -1 | 1) {
    const row = items[index];
    const other = items[index + by];
    if (!row || !other || moving) return;
    const next = allGroups
      .flatMap((g) => g.items)
      .map((s) => (s.id === row.id ? other : s.id === other.id ? row : s));
    setServices(next);
    setMoving(true);
    setRowError(null);
    try {
      setServices(
        await api<ServiceRow[]>(`${base}/services/order`, {
          method: 'PUT',
          body: { serviceIds: next.map((s) => s.id) },
        }),
      );
    } catch (err) {
      setRowError({ id: `svc:${row.id}`, text: errorText(t, err) });
      await load();
    } finally {
      setMoving(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="title-help">
          <h1>{t.services.title}</h1>
          <button
            type="button"
            className="help-btn"
            aria-label={t.services.helpOpen}
            title={t.services.helpOpen}
            aria-expanded={helpOpen}
            aria-controls="services-help"
            onClick={() => setHelpOpen((v) => !v)}
          >
            ?
          </button>
        </div>
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
        {helpOpen ? (
          <p id="services-help" className="small muted help-box">
            {t.services.orderHint}
          </p>
        ) : null}
        {services.length > 0 ? (
          <div className="shop-tools shop-tools--plain">
            <input
              type="search"
              className="input"
              value={filterText}
              aria-label={t.services.listSearch}
              placeholder={t.services.listSearch}
              onChange={(e) => setFilterText(e.target.value)}
            />
            <div className="shop-filters" role="group" aria-label={t.shop.filters}>
              {(['all', 'active', 'hidden', 'noOne'] as const)
                .filter((f) => f === 'all' || counts[f] > 0)
                .map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="shop-filter"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {
                      {
                        all: t.services.filterAll,
                        active: t.services.filterActive,
                        hidden: t.services.filterHidden,
                        noOne: t.services.filterNoOne,
                      }[f]
                    }{' '}
                    <span className="muted">{counts[f]}</span>
                  </button>
                ))}
            </div>
          </div>
        ) : null}
        {filtering && groups.length === 0 ? (
          <p className="small muted">{t.services.noMatch}</p>
        ) : null}
        {groups.map((g, categoryIndex) =>
          g.items.length === 0 && !g.category ? null : (
            <section key={g.category?.id ?? 'none'} className="section">
              {renaming && g.category && renaming.id === g.category.id ? (
                <div>
                  <form noValidate className="copy-field" onSubmit={renameCategory}>
                    <input
                      id="category-rename-name"
                      className="input"
                      aria-label={t.services.categoryName}
                      required
                      autoFocus
                      maxLength={60}
                      value={renaming.name}
                      {...categoryInvalid('rename')}
                      onChange={(e) => {
                        setRenaming({ ...renaming, name: e.target.value });
                        if (categoryProblem?.form === 'rename') setCategoryProblem(null);
                      }}
                    />
                    <button className="btn btn--small" disabled={renameLock.busy}>
                      {t.common.save}
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet btn--small"
                      onClick={() => {
                        setRenaming(null);
                        if (categoryProblem?.form === 'rename') setCategoryProblem(null);
                      }}
                    >
                      {t.common.cancel}
                    </button>
                  </form>
                  <FieldError
                    id="category-rename-error"
                    text={categoryProblem?.form === 'rename' ? categoryProblem.text : undefined}
                  />
                </div>
              ) : (
                <div className="row" style={{ alignItems: 'center' }}>
                  <h2 style={{ flex: '1 1 auto' }}>{g.category?.name ?? t.services.noCategory}</h2>
                  {g.category ? (
                    <>
                      <button
                        type="button"
                        className="link-btn small"
                        style={{ flex: '0 0 auto' }}
                        onClick={() => {
                          setRenaming({ id: g.category!.id, name: g.category!.name });
                          if (categoryProblem?.form === 'rename') setCategoryProblem(null);
                        }}
                      >
                        {t.services.renameCategory}
                      </button>
                      <button
                        type="button"
                        className="link-btn small"
                        style={{ flex: '0 0 auto' }}
                        title={t.services.deleteCategoryHint}
                        aria-describedby={describedBy(`cat:${g.category.id}`)}
                        onClick={() => void removeCategory(g.category!.id)}
                      >
                        {t.services.deleteCategory}
                      </button>
                    </>
                  ) : null}
                  {g.category && categories.length > 1 && !filtering ? (
                    <span className="order-btns">
                      <button
                        type="button"
                        aria-label={fill(t.team.moveUp, { name: g.category.name })}
                        aria-describedby={describedBy(`cat:${g.category.id}`)}
                        disabled={moving || categoryIndex === 0}
                        onClick={() => void moveCategory(categoryIndex, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={fill(t.team.moveDown, { name: g.category.name })}
                        aria-describedby={describedBy(`cat:${g.category.id}`)}
                        disabled={moving || categoryIndex === categories.length - 1}
                        onClick={() => void moveCategory(categoryIndex, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  ) : null}
                </div>
              )}
              {g.category ? (
                <FieldError
                  id={rowErrorId(`cat:${g.category.id}`)}
                  text={rowErrorText(`cat:${g.category.id}`)}
                />
              ) : null}
              <ul className="list">
                {g.items.map((s, index) => (
                  <li
                    key={s.id}
                    className={
                      g.items.length > 1 && !filtering
                        ? `orderable${rowError?.id === `svc:${s.id}` ? ' orderable--error' : ''}`
                        : undefined
                    }
                  >
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
                        </span>
                        {s.active ? null : (
                          <span className="status-pill status-pill--hidden">
                            {t.services.hidden}
                          </span>
                        )}
                        {unstaffed(s) ? (
                          <span className="small warn-text">{t.services.noOnePerforms}</span>
                        ) : null}
                      </span>
                      <span>{formatPrice(s.priceGrosze, location.currency, tag)}</span>
                    </button>
                    {g.items.length > 1 && !filtering ? (
                      <span className="order-btns">
                        <button
                          type="button"
                          aria-label={fill(t.team.moveUp, { name: s.name })}
                          aria-describedby={describedBy(`svc:${s.id}`)}
                          disabled={moving || index === 0}
                          onClick={() => void move(g.items, index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={fill(t.team.moveDown, { name: s.name })}
                          aria-describedby={describedBy(`svc:${s.id}`)}
                          disabled={moving || index === g.items.length - 1}
                          onClick={() => void move(g.items, index, 1)}
                        >
                          ↓
                        </button>
                      </span>
                    ) : null}
                    <FieldError id={rowErrorId(`svc:${s.id}`)} text={rowErrorText(`svc:${s.id}`)} />
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
        <form noValidate className="copy-field" onSubmit={addCategory}>
          <input
            id="category-add-name"
            className="input"
            placeholder={t.services.categoryName}
            aria-label={t.services.categoryName}
            required
            maxLength={60}
            value={newCategory}
            {...categoryInvalid('add')}
            onChange={(e) => {
              setNewCategory(e.target.value);
              if (categoryProblem?.form === 'add') setCategoryProblem(null);
            }}
          />
          <button className="btn btn--quiet" disabled={categoryLock.busy}>
            {t.services.addCategory}
          </button>
        </form>
        <FieldError
          id="category-add-error"
          text={categoryProblem?.form === 'add' ? categoryProblem.text : undefined}
        />
      </div>
      {/* Task 395: the products sold at a visit. */}
      <ProductsSection base={base} />
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

/** Task 661: the service form's fields that can show an error under them. */
type ServiceField = 'name' | 'durationMinutes' | 'priceGrosze' | 'bufferMinutes' | 'description';
const SERVICE_FIELDS: ServiceField[] = [
  'name',
  'durationMinutes',
  'priceGrosze',
  'bufferMinutes',
  'description',
];

/** The fields the server's validation answer is about; empty when it is about something else. */
function serviceFieldsOf(err: unknown): ServiceField[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  const paths = (err.details as { path?: string }[]).map((d) => d.path);
  return SERVICE_FIELDS.filter((f) => paths.includes(f));
}

/** The highest price the server takes: 100 000.00 in the location currency. */
const MAX_PRICE_GROSZE = 10_000_000;

/** Task 687: whole minutes from `min` to `max`, every 5 minutes. */
function stepped(minutes: number, min: number, max: number): boolean {
  return Number.isInteger(minutes) && minutes >= min && minutes <= max && minutes % 5 === 0;
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
  /**
   * Task 661 (owner's rule: errors at the field): the fields with an error shown under them —
   * a name of only spaces or a price above the limit before sending, and the server's answer
   * about the name, duration, price, break or description. Editing a field takes its error away.
   */
  const [problems, setProblems] = useState<ServiceField[]>([]);
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

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const priceGrosze = Math.round(Number(form.price.replace(',', '.')) * 100);
    const before: ServiceField[] = [];
    // Task 687 (owner's rule: errors at the field): the form has no browser checks any more (they
    // showed a bubble instead of the line under the field), so every field is looked at here.
    if (!form.name.trim()) before.push('name');
    if (!stepped(form.durationMinutes, 5, 480)) before.push('durationMinutes');
    if (
      !/^\d+([.,]\d{1,2})?$/.test(form.price.trim()) ||
      !Number.isFinite(priceGrosze) ||
      priceGrosze > MAX_PRICE_GROSZE
    )
      before.push('priceGrosze');
    if (!stepped(form.bufferMinutes, 0, 120)) before.push('bufferMinutes');
    if (before.length > 0) {
      setError('');
      setProblems(before);
      e.currentTarget.querySelector<HTMLInputElement>(`#service-field-${before[0]}`)?.focus();
      return;
    }
    if (!lock()) return;
    setError('');
    setProblems([]);
    const body = {
      name: form.name,
      description: form.description || null,
      durationMinutes: Number(form.durationMinutes),
      bufferMinutes: Number(form.bufferMinutes),
      priceGrosze,
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
      const fields = serviceFieldsOf(err);
      setProblems(fields);
      if (fields.length === 0) setError(errorText(t, err));
      unlock();
    }
  }

  const problemText: Record<ServiceField, string> = {
    name: t.onboarding.fieldRequired,
    durationMinutes: t.services.durationInvalid,
    priceGrosze: t.services.priceInvalid,
    bufferMinutes: t.services.bufferInvalid,
    description: t.errors.VALIDATION_ERROR,
  };
  const problem = (field: ServiceField) =>
    problems.includes(field) ? problemText[field] : undefined;
  /** Editing a field takes its error away. */
  const edit = (field: ServiceField, change: Partial<typeof form>) => {
    setForm({ ...form, ...change });
    if (problems.includes(field)) setProblems(problems.filter((f) => f !== field));
  };
  const invalid = (field: ServiceField) => ({
    'aria-invalid': problems.includes(field) || undefined,
    'aria-describedby': problems.includes(field) ? `service-${field}-error` : undefined,
  });

  return (
    <Sheet
      title={service ? t.services.edit : copyOf ? t.services.copyTitle : t.services.add}
      onClose={onClose}
    >
      <form noValidate className="form" onSubmit={(e) => void save(e)}>
        <ErrorBox>{error}</ErrorBox>
        {copyOf ? (
          <p className="small muted" data-testid="service-copy-hint">
            {t.services.copyHint}
          </p>
        ) : null}
        <label className="field">
          <span>{t.services.name}</span>
          <input
            id="service-field-name"
            required
            maxLength={100}
            value={form.name}
            {...invalid('name')}
            onChange={(e) => edit('name', { name: e.target.value })}
          />
          <FieldError id="service-name-error" text={problem('name')} />
        </label>
        <div className="row">
          <label className="field">
            <span>{t.services.duration}</span>
            <input
              id="service-field-durationMinutes"
              type="number"
              min={5}
              max={480}
              step={5}
              required
              value={form.durationMinutes}
              {...invalid('durationMinutes')}
              onChange={(e) => edit('durationMinutes', { durationMinutes: Number(e.target.value) })}
            />
            <FieldError id="service-durationMinutes-error" text={problem('durationMinutes')} />
          </label>
          <label className="field">
            <span>
              {fill(t.services.price, {
                currency: currencySymbol(location.currency, LOCALE_TAGS[locale]),
              })}
            </span>
            <input
              id="service-field-priceGrosze"
              inputMode="decimal"
              required
              pattern="\d+([.,]\d{1,2})?"
              value={form.price}
              {...invalid('priceGrosze')}
              onChange={(e) => edit('priceGrosze', { price: e.target.value })}
            />
            <FieldError id="service-priceGrosze-error" text={problem('priceGrosze')} />
          </label>
        </div>
        <label className="field">
          <span>{t.services.buffer}</span>
          <input
            id="service-field-bufferMinutes"
            type="number"
            min={0}
            max={120}
            step={5}
            value={form.bufferMinutes}
            {...invalid('bufferMinutes')}
            onChange={(e) => edit('bufferMinutes', { bufferMinutes: Number(e.target.value) })}
          />
          <FieldError id="service-bufferMinutes-error" text={problem('bufferMinutes')} />
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
            {...invalid('description')}
            onChange={(e) => edit('description', { description: e.target.value })}
          />
          <FieldError id="service-description-error" text={problem('description')} />
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
