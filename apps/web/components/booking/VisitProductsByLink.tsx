'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { VisitProducts } from '@/lib/types';
import { FieldError } from '../ui';

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
  bring = [],
}: {
  endpoint: string;
  offer?: boolean;
  /**
   * Task Q3 (screen C): products to put aside right away — "Umów kolejną wizytę" after a visit
   * brings what the specialist used (`?product=…` of the booking link).
   */
  bring?: string[];
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const s = t.visitProducts;
  const [data, setData] = useState<VisitProducts | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Task 759 (owner's rule: errors where the action is): a refused "Zrezygnuj" or "Odbiorę przy
   * wizycie" is said under that product's row (keyed by the row's id), not as a box above the list.
   */
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

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

  const brought = useRef(false);
  useEffect(() => {
    if (!data || brought.current || bring.length === 0) return;
    brought.current = true;
    if (!data.canChange) return;
    const waiting = new Set(
      data.reservations.filter((r) => r.status === 'reserved').map((r) => r.productId),
    );
    const ids = bring.filter(
      (id) => !waiting.has(id) && data.available.some((p) => p.id === id && p.available),
    );
    if (ids.length === 0) return;
    void (async () => {
      let last: VisitProducts | null = null;
      for (const productId of ids) {
        try {
          last = await api<VisitProducts>(`${endpoint}/products`, {
            method: 'POST',
            auth: false,
            body: { productId, quantity: 1 },
          });
        } catch {
          // Sold out meanwhile: the client still sees the salon's products to pick from.
        }
      }
      if (last) setData(last);
    })();
  }, [data, bring, endpoint]);

  const run = async (rowId: string, action: () => Promise<VisitProducts>) => {
    setBusy(true);
    setError(null);
    try {
      setData(await action());
    } catch (e) {
      setError({ id: rowId, text: errorText(t, e) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const reserved = data.reservations.filter((r) => r.status !== 'cancelled');
  if (reserved.length === 0 && (!data.canChange || data.available.length === 0)) return null;
  const money = (n: number) => formatPrice(n, data.currency, tag);
  const errorId = (rowId: string) => `visit-product-${rowId}-error`;
  const errorFor = (rowId: string) => (error?.id === rowId ? error.text : undefined);
  const shown = offer ? data.available.slice(0, OFFER_LIMIT) : data.available;
  // The row may be gone after the refresh (or the list folded): then under the heading.
  const lostError =
    error &&
    !reserved.some((r) => `r:${r.id}` === error.id) &&
    !(open && shown.some((p) => `p:${p.id}` === error.id))
      ? error.text
      : undefined;

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
      <FieldError id="visit-products-error" text={lostError} />
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
                  aria-describedby={errorFor(`r:${r.id}`) ? errorId(`r:${r.id}`) : undefined}
                  onClick={() =>
                    void run(`r:${r.id}`, () =>
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
              <FieldError id={errorId(`r:${r.id}`)} text={errorFor(`r:${r.id}`)} />
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
              {shown.map((p) => (
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
                    aria-describedby={errorFor(`p:${p.id}`) ? errorId(`p:${p.id}`) : undefined}
                    onClick={() =>
                      void run(`p:${p.id}`, () =>
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
                  <FieldError id={errorId(`p:${p.id}`)} text={errorFor(`p:${p.id}`)} />
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
