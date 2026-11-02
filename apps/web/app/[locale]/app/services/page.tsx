'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useSession } from '@/components/Session';
import { ErrorBox, Sheet, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { Service, ServiceCategory } from '@/lib/types';

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
  const [editing, setEditing] = useState<ServiceRow | 'new' | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        api<ServiceRow[]>(`${base}/services`),
        api<Category[]>(`${base}/service-categories`),
      ]);
      setServices(s);
      setCategories(c);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`${base}/service-categories`, {
        method: 'POST',
        body: { name: newCategory, sortOrder: categories.length },
      });
      setNewCategory('');
      await load();
    } catch (err) {
      setError(errorText(t, err));
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
          <button className="btn btn--quiet">{t.services.addCategory}</button>
        </form>
      </div>
      {editing ? (
        <ServiceSheet
          base={base}
          service={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
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
  onClose,
  onSaved,
}: {
  base: string;
  service: ServiceRow | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
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
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
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
      if (service) {
        await api(`${base}/services/${service.id}`, {
          method: 'PATCH',
          body: { ...body, version: service.version },
        });
      } else {
        await api(`${base}/services`, { method: 'POST', body });
      }
      onSaved();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
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
        <button className="btn btn--block" disabled={busy}>
          {t.common.save}
        </button>
      </form>
    </Sheet>
  );
}
