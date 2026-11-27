'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatDay, formatPrice } from '@/lib/time';
import type { UsedProducts } from '@/lib/types';
import { FieldError } from '../ui';

/** Products marked by the specialist. Pickup orders use the completed visit;
 * only products selected for a future visit accompany a new booking. */
export function UsedProductsByLink({ endpoint, slug }: { endpoint: string; slug: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const s = t.visitProducts;
  const [data, setData] = useState<UsedProducts | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  const [buying, setBuying] = useState<string | null>(null);
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Task 760 (owner's rule: errors where the action is): a refused "Odłóż na następną wizytę" is
   * said under that product's button, not as a box above the list.
   */
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(
    () =>
      api<UsedProducts>(`${endpoint}/products/used`, { auth: false })
        .then((result) => {
          setData(result);
          setReadError('');
          return result;
        })
        .catch((err) => {
          setReadError(errorText(t, err));
          return null;
        }),
    [endpoint, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!data)
    return readError ? (
      <section className="section stack" aria-label={s.usedTitle}>
        <h2 className="h3">{s.usedTitle}</h2>
        <p role="alert">{readError}</p>
        <button className="btn btn--quiet" type="button" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </section>
    ) : null;
  if (data.products.length === 0) return null;
  const next = data.nextVisit;
  const money = (n: number) => formatPrice(n, data.currency, tag);
  const when = next ? `${next.time} · ${formatDay(next.date, tag, { short: true })}` : '';
  const toBring = data.products
    .filter((p) => p.available && selected.includes(p.id))
    .map((p) => p.id);
  const query = new URLSearchParams({
    service: data.rebook.serviceId,
    staff: data.rebook.staffId,
    ...(toBring.length ? { product: toBring.join(',') } : {}),
  });

  async function save(productId: string, action: 'next' | 'pickup' = 'next') {
    setBusy(true);
    setError(null);
    try {
      setData(
        await api<UsedProducts>(`${endpoint}/products/${action}`, {
          method: 'POST',
          auth: false,
          body: { productId, quantity: 1 },
        }),
      );
    } catch (e) {
      setError({ id: productId, text: errorText(t, e) });
      const refreshed = await load();
      const item = refreshed?.products.find((p) => p.id === productId);
      if (action === 'pickup' ? item?.pickupStatus : item?.reservedForNext) setError(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="section stack"
      aria-labelledby="used-products-title"
      data-testid="used-products"
    >
      <h2 id="used-products-title" className="h3">
        {s.usedTitle}
      </h2>
      <ul className="list" aria-label={s.usedTitle}>
        {data.products.map((p) => (
          <li key={p.id} className="stack" style={{ gap: 8 }}>
            <span className="row" style={{ alignItems: 'center', gap: 12 }}>
              {p.photoId ? (
                <img
                  src={`/v1/public/photos/${p.photoId}`}
                  alt=""
                  width={56}
                  height={56}
                  loading="lazy"
                  style={{ objectFit: 'cover', borderRadius: 10, flex: 'none' }}
                />
              ) : null}
              <span className="stack" style={{ gap: 2, flex: 1 }}>
                <span>
                  <strong>{p.name}</strong>
                  {p.brand ? <span className="muted"> · {p.brand}</span> : null}
                </span>
                <span className="small muted">
                  {money(p.priceGrosze)}
                  {!p.available && !p.reservedForNext && !p.pickupStatus
                    ? ` · ${s.unavailable}`
                    : ''}
                </span>
              </span>
            </span>
            {p.description && (
              <p className="small muted" style={{ overflowWrap: 'anywhere' }}>
                {p.description}
              </p>
            )}
            {p.pickupStatus ? (
              <p role="status">{p.pickupStatus === 'handed' ? s.pickupHanded : s.pickupOrdered}</p>
            ) : p.available ? (
              <>
                <button
                  type="button"
                  className="btn btn--quiet"
                  aria-expanded={buying === p.id}
                  aria-label={`${s.buy}: ${p.name}`}
                  onClick={() => setBuying(buying === p.id ? null : p.id)}
                >
                  {s.buy}
                </button>
                {buying === p.id && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void save(p.id, 'pickup')}
                  >
                    {s.orderForPickup}
                  </button>
                )}
              </>
            ) : null}
            {!next && p.available && (
              <label>
                <input
                  type="checkbox"
                  aria-label={`${s.saveForNext}: ${p.name}`}
                  checked={selected.includes(p.id)}
                  onChange={() => toggle(p.id)}
                />{' '}
                {s.saveForNext}
              </label>
            )}
            {next && p.reservedForNext ? (
              <p className="small" role="status">
                <strong>✓ {fill(s.savedForNext, { when })}</strong>
              </p>
            ) : next ? (
              <button
                type="button"
                className="btn btn--quiet btn--block"
                disabled={busy || !p.available}
                aria-label={`${s.saveForNext}: ${p.name}`}
                aria-describedby={error?.id === p.id ? `used-product-${p.id}-error` : undefined}
                onClick={() => void save(p.id)}
              >
                {s.saveForNext}
              </button>
            ) : null}
            <FieldError
              id={`used-product-${p.id}-error`}
              text={error?.id === p.id ? error.text : undefined}
            />
          </li>
        ))}
      </ul>
      <p className="small muted">{s.payAtPickup}</p>
      {next ? null : (
        <>
          <p className="small muted">
            {s.noNext}
            {toBring.length ? ` ${s.bookNextHint}` : ''}
          </p>
          <Link className="btn btn--block" href={`/${locale}/b/${slug}?${query.toString()}`}>
            {s.bookNext}
          </Link>
        </>
      )}
    </section>
  );
}
