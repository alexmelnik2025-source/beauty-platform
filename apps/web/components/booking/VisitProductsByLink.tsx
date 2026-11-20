'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { VisitProducts } from '@/lib/types';
import { ErrorBox } from '../ui';

/**
 * Task Q3 (part 4b, screen B): "Produkty do odbioru" on the visit's "manage" page — what the
 * client put aside for this visit, and "+ Dodaj produkt do tej wizyty" (folded) with the salon's
 * products: "Odbiorę przy wizycie" puts one aside, paid at the salon. Nothing is shown when the
 * salon has no products for clients and nothing was put aside. Until the visit starts the client
 * may take a product back.
 * Screen A (`offer`): the same, folded, on the "booked" screen right after booking — titled
 * "Dodać coś do wizyty?", with at most three products, nothing when the salon shows none.
 */
const OFFER_LIMIT = 3;

export function VisitProductsByLink({
  endpoint,
  offer = false,
}: {
  endpoint: string;
  offer?: boolean;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const s = t.visitProducts;
  const [data, setData] = useState<VisitProducts | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api<VisitProducts>(`${endpoint}/products`, { auth: false })
        .then(setData)
        .catch(() => setData(null)),
    [endpoint],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<VisitProducts>) => {
    setBusy(true);
    setError('');
    try {
      setData(await action());
    } catch (e) {
      setError(errorText(t, e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const reserved = data.reservations.filter((r) => r.status !== 'cancelled');
  if (reserved.length === 0 && (!data.canChange || data.available.length === 0)) return null;
  const money = (n: number) => formatPrice(n, data.currency, tag);

  return (
    <section
      className="section"
      aria-labelledby="visit-products-title"
      data-testid={offer ? 'booked-products' : 'visit-products'}
    >
      {offer ? (
        <h2 id="visit-products-title" className="h3">
          {s.offerTitle}
        </h2>
      ) : (
        <h2 id="visit-products-title">{s.title}</h2>
      )}
      <ErrorBox>{error}</ErrorBox>
      {reserved.length > 0 ? (
        <ul className="list" aria-label={s.title}>
          {reserved.map((r) => (
            <li key={r.id} className="row" style={{ alignItems: 'center', gap: 12 }}>
              {r.photoId ? (
                <img
                  src={`/v1/public/photos/${r.photoId}`}
                  alt=""
                  width={48}
                  height={48}
                  loading="lazy"
                  style={{ objectFit: 'cover', borderRadius: 8, flex: 'none' }}
                />
              ) : null}
              <span className="stack" style={{ gap: 2, flex: 1 }}>
                <span>
                  <strong>{r.name}</strong>
                  {r.quantity > 1 ? ` × ${r.quantity}` : ''}
                </span>
                <span className="small muted">
                  {r.status === 'reserved' ? s.statusReserved : null}
                  {r.status === 'handed' ? s.statusHanded : null}
                  {r.status === 'expired' ? s.statusExpired : null}
                </span>
              </span>
              <span>{money(r.totalGrosze)}</span>
              {data.canChange && r.status === 'reserved' ? (
                <button
                  type="button"
                  className="link-btn small"
                  disabled={busy}
                  aria-label={`${s.giveBack}: ${r.name}`}
                  onClick={() =>
                    void run(() =>
                      api<VisitProducts>(`${endpoint}/products/${r.id}`, {
                        method: 'DELETE',
                        auth: false,
                      }),
                    )
                  }
                >
                  {s.giveBack}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {reserved.length > 0 ? (
        <p className="small muted">{fill(s.total, { amount: money(data.totalGrosze) })}</p>
      ) : null}
      {data.canChange && data.available.length > 0 ? (
        <>
          <button
            type="button"
            className="btn btn--quiet btn--small"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {s.add}
          </button>
          {open ? (
            <ul className="list" aria-label={s.addTitle}>
              {(offer ? data.available.slice(0, OFFER_LIMIT) : data.available).map((p) => (
                <li key={p.id} className="row" style={{ alignItems: 'center', gap: 12 }}>
                  {p.photoId ? (
                    <img
                      src={`/v1/public/photos/${p.photoId}`}
                      alt=""
                      width={48}
                      height={48}
                      loading="lazy"
                      style={{ objectFit: 'cover', borderRadius: 8, flex: 'none' }}
                    />
                  ) : null}
                  <span className="stack" style={{ gap: 2, flex: 1 }}>
                    <span>
                      <strong>{p.name}</strong>
                      {p.brand ? <span className="muted"> · {p.brand}</span> : null}
                    </span>
                    <span className="small muted">
                      {money(p.priceGrosze)}
                      {!p.available ? ` · ${s.unavailable}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy || !p.available}
                    aria-label={`${s.reserve}: ${p.name}`}
                    onClick={() =>
                      void run(() =>
                        api<VisitProducts>(`${endpoint}/products`, {
                          method: 'POST',
                          auth: false,
                          body: { productId: p.id, quantity: 1 },
                        }),
                      )
                    }
                  >
                    {s.reserve}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="small muted">{s.pickup}</p>
        </>
      ) : null}
    </section>
  );
}
