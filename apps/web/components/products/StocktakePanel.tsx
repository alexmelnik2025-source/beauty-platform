'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { Product, Stocktake } from '@/lib/types';
import { ErrorBox } from '../ui';

/** "" → null (not counted now), "12" → 12; anything else → undefined (wrong). */
function parseCount(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) <= 100_000 ? Number(text) : undefined;
}

/**
 * Task 457: "Inwentaryzacja" — the owner counts what is on the shelf and writes the numbers for all
 * products on one screen; the server writes each difference to "Historia magazynu" and says how
 * many pieces were missing or extra. An empty field leaves the product as it is.
 */
export function StocktakePanel({
  base,
  products,
  onSaved,
}: {
  base: string;
  products: Product[];
  onSaved: (result: Stocktake) => void;
}) {
  const { t } = useI18n();
  const p = t.products;
  const [counts, setCounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      products.map((x) => [x.id, x.stockQuantity === null ? '' : String(x.stockQuantity)]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const parsed = products.map((x) => ({ product: x, count: parseCount(counts[x.id] ?? '') }));
  const wrong = parsed.some((r) => r.count === undefined);
  const changes = parsed.flatMap(({ product, count }) =>
    typeof count === 'number' && count !== product.stockQuantity
      ? [{ productId: product.id, quantity: count }]
      : [],
  );

  async function save() {
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api<Stocktake>(`${base}/products/stocktake`, {
          method: 'POST',
          body: { counts: changes },
        }),
      );
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="stocktake"
      style={{
        border: '1px solid var(--line)',
        borderRadius: '0.5rem',
        padding: '0.75rem 1rem',
        marginBottom: '1rem',
      }}
    >
      <h3>{p.stocktakeTitle}</h3>
      <p className="small muted">{p.stocktakeHint}</p>
      <ErrorBox>{error}</ErrorBox>
      <ul className="commission-list">
        {parsed.map(({ product: x, count }) => (
          <li key={x.id} className="commission-row" data-testid="stocktake-row">
            <span style={{ flex: '1 1 12rem' }}>{x.name}</span>
            <span className="small muted">
              {x.stockQuantity === null
                ? p.stocktakeWasNone
                : p.stocktakeWas.replace('{n}', String(x.stockQuantity))}
            </span>
            <span className="commission-row__input">
              <input
                inputMode="numeric"
                aria-label={p.stocktakeCount.replace('{name}', x.name)}
                aria-invalid={count === undefined}
                placeholder="—"
                value={counts[x.id] ?? ''}
                onChange={(e) => setCounts({ ...counts, [x.id]: e.target.value })}
              />
              <span aria-hidden="true">{p.pieces}</span>
            </span>
            {typeof count === 'number' && x.stockQuantity !== null && count !== x.stockQuantity ? (
              <span className="badge" data-testid="stocktake-diff">
                {count < x.stockQuantity
                  ? p.stocktakeMissing.replace('{n}', String(x.stockQuantity - count))
                  : p.stocktakeExtra.replace('{n}', String(count - x.stockQuantity))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || wrong || changes.length === 0}
          onClick={() => void save()}
        >
          {p.stocktakeSave}
        </button>
      </p>
    </div>
  );
}
