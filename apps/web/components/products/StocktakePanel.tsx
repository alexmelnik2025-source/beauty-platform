'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { errorText, fill, useI18n } from '@/lib/i18n';
import type { Product, Stocktake } from '@/lib/types';
import { ErrorBox, FieldError } from '../ui';

/** "" → null (not counted now), "12" → 12; anything else → undefined (wrong). */
function parseCount(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) <= 100_000 ? Number(text) : undefined;
}

/** Task 670: the products of the sent list that the server's validation answer is about. */
function wrongProductsOf(err: unknown, sent: string[]): string[] {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return [];
  if (!Array.isArray(err.details)) return [];
  return (err.details as { path?: string }[]).flatMap((d) => {
    const m = /^counts\.(\d+)(\.|$)/.exec(String(d.path ?? ''));
    const id = m ? sent[Number(m[1])] : undefined;
    return id ? [id] : [];
  });
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
  /**
   * Task 670 (owner's rule: errors at the field): the products whose number the server did not
   * take; a wrong number typed is said under its field at once. Editing the field clears it.
   */
  const [serverWrong, setServerWrong] = useState<string[]>([]);
  /** Task 721: "Zapisz inwentaryzację" pressed with nothing changed — said under the first field. */
  const [same, setSame] = useState(false);

  const parsed = products.map((x) => ({ product: x, count: parseCount(counts[x.id] ?? '') }));
  const changes = parsed.flatMap(({ product, count }) =>
    typeof count === 'number' && count !== product.stockQuantity
      ? [{ productId: product.id, quantity: count }]
      : [],
  );

  const sameId = same && changes.length === 0 ? parsed[0]?.product.id : undefined;
  const bad = (id: string, value: number | null | undefined) =>
    value === undefined || serverWrong.includes(id) || id === sameId;

  async function save() {
    // Task 721 (owner's rule: errors at the field): the button is not silently off — a wrong number
    // or no difference at all sends the cursor to the field that says so.
    const first =
      parsed.find((r) => r.count === undefined) ?? (changes.length === 0 ? parsed[0] : null);
    if (first) {
      if (changes.length === 0 && first.count !== undefined) setSame(true);
      document.getElementById(`stocktake-${first.product.id}`)?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setServerWrong([]);
    try {
      onSaved(
        await api<Stocktake>(`${base}/products/stocktake`, {
          method: 'POST',
          body: { counts: changes },
        }),
      );
    } catch (err) {
      const ids = wrongProductsOf(
        err,
        changes.map((i) => i.productId),
      );
      setServerWrong(ids);
      if (ids.length === 0) setError(errorText(t, err));
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
                id={`stocktake-${x.id}`}
                inputMode="numeric"
                aria-label={p.stocktakeCount.replace('{name}', x.name)}
                aria-invalid={bad(x.id, count) || undefined}
                aria-describedby={bad(x.id, count) ? `stocktake-${x.id}-error` : undefined}
                placeholder="—"
                value={counts[x.id] ?? ''}
                onChange={(e) => {
                  setCounts({ ...counts, [x.id]: e.target.value });
                  setServerWrong(serverWrong.filter((id) => id !== x.id));
                  setSame(false);
                }}
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
            <FieldError
              id={`stocktake-${x.id}-error`}
              text={
                x.id === sameId && count !== undefined
                  ? p.stocktakeSame
                  : bad(x.id, count)
                    ? fill(t.guard.numberRange, { min: '0', max: '100 000' })
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
          {p.stocktakeSave}
        </button>
      </p>
    </div>
  );
}
