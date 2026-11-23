'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import { orderQuantity } from '@/lib/to-order';
import type { Product, StockDelivery } from '@/lib/types';
import { ErrorBox, FieldError } from '../ui';

/** "" → null (nothing came), "12" → 12; anything else (0 too) → undefined (wrong). */
function parsePieces(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) >= 1 && Number(text) <= 100_000
    ? Number(text)
    : undefined;
}

/** Task 670: the products of the sent list that the server's validation answer is about. */
function wrongProductsOf(err: unknown, sent: string[]): string[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  return (err.details as { path?: string }[]).flatMap((d) => {
    const m = /^items\.(\d+)(\.|$)/.exec(String(d.path ?? ''));
    const id = m ? sent[Number(m[1])] : undefined;
    return id ? [id] : [];
  });
}

/**
 * Task 476: "Przyjmij dostawę" — the whole order from the supplier on one screen: the pieces that
 * came for each product, added to the stock in one step (each a "Dostawa" in "Historia
 * magazynu"). The products to order start with the suggested numbers of "Tekst zamówienia"
 * (task 473), the others empty; with suppliers written, the list can show one supplier only.
 */
export function DeliveryPanel({
  base,
  products,
  sold30,
  onSaved,
}: {
  base: string;
  products: Product[];
  sold30: ReadonlyMap<string, number>;
  onSaved: (result: StockDelivery) => void;
}) {
  const { t } = useI18n();
  const p = t.products;
  const active = products.filter((x) => x.active);
  const [pieces, setPieces] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      active.map((x) => [
        x.id,
        x.lowStock || x.stockQuantity === 0 ? String(orderQuantity(x, sold30.get(x.id) ?? 0)) : '',
      ]),
    ),
  );
  /** "" = all suppliers. */
  const [supplier, setSupplier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * Task 670 (owner's rule: errors at the field): the products whose number the server did not
   * take; a wrong number typed is said under its field at once. Editing the field clears it.
   */
  const [serverWrong, setServerWrong] = useState<string[]>([]);
  /** Task 710: "Przyjmij dostawę" pressed with no pieces typed — said under the first field. */
  const [empty, setEmpty] = useState(false);

  const suppliers = [
    ...new Map(
      active
        .filter((x) => x.supplier !== null)
        .map((x) => [x.supplier!.toLocaleLowerCase(), x.supplier!]),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  const shown = active.filter(
    (x) => supplier === '' || x.supplier?.toLocaleLowerCase() === supplier.toLocaleLowerCase(),
  );
  const parsed = shown.map((x) => ({ product: x, n: parsePieces(pieces[x.id] ?? '') }));
  const items = parsed.flatMap(({ product, n }) =>
    typeof n === 'number' ? [{ productId: product.id, quantity: n }] : [],
  );
  const emptyId = empty && items.length === 0 ? parsed[0]?.product.id : undefined;
  const bad = (id: string, value: number | null | undefined) =>
    value === undefined || serverWrong.includes(id) || id === emptyId;
  const total = items.reduce((sum, i) => sum + i.quantity, 0);

  async function save() {
    // Task 710 (owner's rule: errors at the field): the button is not silently off — a wrong number
    // or no pieces at all sends the cursor to the field that says so.
    const first = parsed.find((r) => r.n === undefined) ?? (items.length === 0 ? parsed[0] : null);
    if (first) {
      if (items.length === 0 && first.n !== undefined) setEmpty(true);
      document.getElementById(`delivery-${first.product.id}`)?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setServerWrong([]);
    try {
      onSaved(
        await api<StockDelivery>(`${base}/products/delivery`, {
          method: 'POST',
          body: { items },
        }),
      );
    } catch (err) {
      const ids = wrongProductsOf(
        err,
        items.map((i) => i.productId),
      );
      setServerWrong(ids);
      if (ids.length === 0) setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="delivery"
      style={{
        border: '1px solid var(--line)',
        borderRadius: '0.5rem',
        padding: '0.75rem 1rem',
        marginBottom: '1rem',
      }}
    >
      <h3>{p.deliveryTitle}</h3>
      <p className="small muted">{p.deliveryHint}</p>
      <ErrorBox>{error}</ErrorBox>
      {suppliers.length > 0 ? (
        <p>
          <select
            aria-label={p.deliverySupplier}
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          >
            <option value="">{p.supplierAll}</option>
            {suppliers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </p>
      ) : null}
      <ul className="commission-list">
        {parsed.map(({ product: x, n }) => (
          <li key={x.id} className="commission-row" data-testid="delivery-row">
            <span style={{ flex: '1 1 12rem' }}>{x.name}</span>
            <span className="small muted">
              {x.stockQuantity === null
                ? p.stocktakeWasNone
                : p.stocktakeWas.replace('{n}', String(x.stockQuantity))}
            </span>
            <span className="commission-row__input">
              <input
                id={`delivery-${x.id}`}
                inputMode="numeric"
                aria-label={p.deliveryCame.replace('{name}', x.name)}
                aria-invalid={bad(x.id, n) || undefined}
                aria-describedby={bad(x.id, n) ? `delivery-${x.id}-error` : undefined}
                placeholder="—"
                value={pieces[x.id] ?? ''}
                onChange={(e) => {
                  setPieces({ ...pieces, [x.id]: e.target.value });
                  setServerWrong(serverWrong.filter((id) => id !== x.id));
                  setEmpty(false);
                }}
              />
              <span aria-hidden="true">{p.pieces}</span>
            </span>
            <FieldError
              id={`delivery-${x.id}-error`}
              text={
                x.id === emptyId && n === null
                  ? p.deliveryEmpty
                  : bad(x.id, n)
                    ? fill(t.guard.numberRange, { min: '1', max: '100 000' })
                    : undefined
              }
            />
          </li>
        ))}
      </ul>
      <p>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || parsed.length === 0}
          onClick={() => void save()}
        >
          {p.deliverySave.replace('{n}', String(total))}
        </button>
      </p>
    </div>
  );
}
