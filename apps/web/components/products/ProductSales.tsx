'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { Product, ProductList, VisitProductSales } from '@/lib/types';
import { ErrorBox } from '../ui';

/**
 * Task 395: "Produkty" in the card of a visit that took place — what the client bought (pomade,
 * shampoo…) from the salon's list, with "Usuń" for a mistake. Not part of the visit price,
 * loyalty points or discounts. `canChange` = may change this visit (the server checks it too).
 */
export function ProductSales({
  base,
  appointmentId,
  currency,
  canChange,
}: {
  base: string;
  appointmentId: string;
  currency: string;
  canChange: boolean;
}) {
  const { t, locale } = useI18n();
  const p = t.products;
  const tag = LOCALE_TAGS[locale];
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<VisitProductSales | null>(null);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const url = `${base}/appointments/${appointmentId}/products`;
  const money = (hundredths: number) => formatPrice(hundredths, currency, tag);

  const load = useCallback(async () => {
    try {
      const [list, sold] = await Promise.all([
        canChange
          ? api<ProductList>(`${base}/products`)
          : Promise.resolve<ProductList>({ products: [] }),
        api<VisitProductSales>(url),
      ]);
      setProducts(list.products.filter((x) => x.active));
      setSales(sold);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, url, canChange, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<VisitProductSales>) {
    setBusy(true);
    setError('');
    try {
      setSales(await action());
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (!sales) return null;
  // Nothing sold and nothing to sell: no section at all.
  if (sales.sales.length === 0 && (!canChange || products.length === 0)) return null;

  return (
    <div className="stack" style={{ gap: 6 }} data-testid="visit-products">
      <span className="small muted">
        {p.sold}
        {sales.totalGrosze > 0 ? `: ${money(sales.totalGrosze)}` : null}
      </span>
      {sales.sales.length > 0 ? (
        <ul className="commission-list">
          {sales.sales.map((s) => (
            <li key={s.id} className="commission-row">
              <span style={{ flex: '1 1 10rem' }}>
                {s.name}
                {s.quantity > 1 ? ` × ${s.quantity}` : null}
              </span>
              <span>{money(s.totalGrosze)}</span>
              {canChange ? (
                <button
                  type="button"
                  className="link-btn small"
                  aria-label={`${p.removeSale} — ${s.name}`}
                  disabled={busy}
                  onClick={() =>
                    void run(() => api<VisitProductSales>(`${url}/${s.id}`, { method: 'DELETE' }))
                  }
                >
                  {p.removeSale}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canChange && products.length > 0 ? (
        <form
          className="row"
          style={{ gap: 8, alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!productId) return;
            void run(() =>
              api<VisitProductSales>(url, { method: 'POST', body: { productId, quantity } }),
            ).then(() => {
              setProductId('');
              setQuantity(1);
            });
          }}
        >
          <select
            aria-label={p.choose}
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            style={{ flex: '1 1 12rem' }}
          >
            <option value="">{p.choose}</option>
            {products.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {money(x.priceGrosze)}
              </option>
            ))}
          </select>
          <input
            aria-label={p.quantity}
            type="number"
            min={1}
            max={99}
            value={quantity}
            onChange={(e) => setQuantity(Math.min(99, Math.max(1, Number(e.target.value) || 1)))}
            style={{ maxWidth: 70 }}
          />
          <button type="submit" className="btn btn--quiet btn--small" disabled={busy || !productId}>
            + {p.addSale}
          </button>
        </form>
      ) : null}
      <span className="small muted">{p.soldHint}</span>
      <ErrorBox>{error}</ErrorBox>
    </div>
  );
}
