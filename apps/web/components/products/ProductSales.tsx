'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { Product, ProductList, VisitProductSales } from '@/lib/types';
import { parseBarcode } from '@/lib/barcode';
import { ErrorBox, FieldError } from '../ui';

/** Task 673: the fields of a visit's product sale that can show an error under them. */
type SaleField = 'code' | 'product' | 'quantity';

/**
 * Task 395: "Produkty" in the card of a visit that took place — what the client bought (pomade,
 * shampoo…) from the salon's list, with "Usuń" for a mistake. Not part of the visit price,
 * loyalty points or discounts. `canChange` = may change this visit (the server checks it too).
 * Task 524: "Kod kreskowy" — a code typed or scanned (a scanner types it and presses Enter) adds
 * one piece of the product with that code; shown when some product of the salon has a code.
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
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * Task 673 (owner's rule: errors at the field): an unknown code and "not enough in stock" are said
   * under the field they came from (the code, or the number of pieces); editing it takes them away.
   * Task 682: "+ Dodaj" no longer stays silently off — an empty or wrong code, or no product
   * chosen, is said under that field.
   */
  const [problem, setProblem] = useState<{ field: SaleField; text: string } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const url = `${base}/appointments/${appointmentId}/products`;
  const money = (hundredths: number) => formatPrice(hundredths, currency, tag);

  const load = useCallback(async () => {
    try {
      const [list, sold] = await Promise.all([
        canChange
          ? api<ProductList>(`${base}/products`)
          : Promise.resolve<ProductList>({ products: [], sold30Days: [] }),
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

  useEffect(() => {
    if (!problem) return;
    boxRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [problem]);

  async function run(action: () => Promise<VisitProductSales>, field?: SaleField) {
    setBusy(true);
    setError('');
    setProblem(null);
    try {
      setSales(await action());
      // Task 430: the pieces left in stock changed with the sale.
      if (canChange) {
        const list = await api<ProductList>(`${base}/products`);
        setProducts(list.products.filter((x) => x.active));
      }
    } catch (err) {
      if (field && err instanceof ApiError && err.code === 'OUT_OF_STOCK') {
        setProblem({ field, text: errorText(t, err) });
      } else setError(errorText(t, err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  /** Task 524: one piece of the product with this code, or "no such product". */
  function sellByCode() {
    const wanted = parseBarcode(code);
    if (!wanted) {
      setError('');
      setProblem({
        field: 'code',
        text: wanted === null ? t.onboarding.fieldRequired : p.wrongBarcode,
      });
      return;
    }
    const found = products.find((x) => x.barcode === wanted);
    if (!found) {
      setError('');
      setProblem({ field: 'code', text: p.codeUnknown.replace('{code}', wanted) });
      return;
    }
    run(
      () =>
        api<VisitProductSales>(url, { method: 'POST', body: { productId: found.id, quantity: 1 } }),
      'code',
    ).then(
      () => setCode(''),
      () => undefined,
    );
  }
  const withCodes = products.some((x) => x.barcode !== null);

  /** Editing a field takes its error away. */
  const clear = (field: SaleField) => {
    if (problem?.field === field) setProblem(null);
  };
  const errorId = (field: SaleField) => `visit-products-${field}-error-${appointmentId}`;
  const invalid = (field: SaleField) => ({
    'aria-invalid': problem?.field === field || undefined,
    'aria-describedby': problem?.field === field ? errorId(field) : undefined,
  });
  const fieldError = (field: SaleField) => (
    <FieldError id={errorId(field)} text={problem?.field === field ? problem.text : undefined} />
  );

  if (!sales) return null;
  // Nothing sold and nothing to sell: no section at all.
  if (sales.sales.length === 0 && (!canChange || products.length === 0)) return null;

  return (
    <div
      className="stack visit-products"
      ref={boxRef}
      style={{ gap: 6 }}
      data-testid="visit-products"
    >
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
                    void run(() =>
                      api<VisitProductSales>(`${url}/${s.id}`, { method: 'DELETE' }),
                    ).catch(() => undefined)
                  }
                >
                  {p.removeSale}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canChange && withCodes ? (
        <form
          className="row"
          style={{ gap: 8, alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            sellByCode();
          }}
        >
          <input
            aria-label={p.saleByCode}
            placeholder={p.saleByCode}
            value={code}
            maxLength={40}
            autoComplete="off"
            {...invalid('code')}
            onChange={(e) => {
              setCode(e.target.value);
              clear('code');
            }}
            style={{ flex: '1 1 12rem' }}
            data-testid="visit-products-code"
          />
          <button type="submit" className="btn btn--quiet btn--small" disabled={busy}>
            + {p.addSale}
          </button>
        </form>
      ) : null}
      {/* Under the row, so "+ Dodaj" stays level with the field. */}
      {fieldError('code')}
      {canChange && products.length > 0 ? (
        <form
          noValidate
          className="row"
          style={{ gap: 8, alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!productId) {
              setError('');
              setProblem({ field: 'product', text: t.onboarding.fieldRequired });
              return;
            }
            run(
              () => api<VisitProductSales>(url, { method: 'POST', body: { productId, quantity } }),
              'quantity',
            ).then(
              () => {
                setProductId('');
                setQuantity(1);
              },
              () => undefined,
            );
          }}
        >
          <select
            aria-label={p.choose}
            value={productId}
            {...invalid('product')}
            onChange={(e) => {
              setProductId(e.target.value);
              clear('product');
              clear('quantity');
            }}
            style={{ flex: '1 1 12rem' }}
          >
            <option value="">{p.choose}</option>
            {products.map((x) => (
              <option
                key={x.id}
                value={x.id}
                disabled={x.stockQuantity !== null && x.stockQuantity < 1}
              >
                {x.name} · {money(x.priceGrosze)}
                {x.stockQuantity === null
                  ? ''
                  : ` · ${
                      x.stockQuantity > 0
                        ? p.stockLeft.replace('{n}', String(x.stockQuantity))
                        : p.stockNone
                    }`}
                {x.lowStock && x.stockQuantity !== 0 ? ` · ${p.lowBadge}` : ''}
              </option>
            ))}
          </select>
          <input
            aria-label={p.quantity}
            type="number"
            min={1}
            max={99}
            step={1}
            inputMode="numeric"
            value={quantity}
            {...invalid('quantity')}
            onChange={(e) => {
              // Task 703: whole pieces only — "2,5" becomes 2 instead of the browser's own
              // "enter a valid value" bubble on "+ Dodaj".
              setQuantity(Math.min(99, Math.max(1, Math.floor(Number(e.target.value)) || 1)));
              clear('quantity');
            }}
            style={{ maxWidth: 70 }}
          />
          <button type="submit" className="btn btn--quiet btn--small" disabled={busy}>
            + {p.addSale}
          </button>
        </form>
      ) : null}
      {fieldError('product')}
      {fieldError('quantity')}
      <span className="small muted">{p.soldHint}</span>
      <ErrorBox>{error}</ErrorBox>
    </div>
  );
}
