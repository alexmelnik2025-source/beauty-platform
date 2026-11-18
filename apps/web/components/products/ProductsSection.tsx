'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiResponse } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';
import type { Product, ProductList } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox } from '../ui';
import { parseTip as parseAmount } from '../calendar/TipField';

/** "" → null (not counted), "12" → 12; anything else → undefined (wrong). Task 430. */
function parseStock(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) <= 100_000 ? Number(text) : undefined;
}

const stockInput = (n: number | null) => (n === null ? '' : String(n));

/** 4500 → "45", 4550 → "45,50" — for the price field. */
function amountInput(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const cents = hundredths % 100;
  return cents === 0 ? String(whole) : `${whole},${String(cents).padStart(2, '0')}`;
}

/**
 * Task 395: "Produkty" in "Usługi" — the salon's own list of products sold at a visit (pomade,
 * shampoo…): add, change the name or price, "Nie sprzedajemy", remove. Past sales keep the
 * name and price they had. Owners and managers (the page is theirs).
 * Task 430: "W magazynie" — pieces in stock (empty = not counted); a sale at a visit takes them
 * away, "Brak" when none are left.
 * Task 434: "Kończy się przy" — the salon's own number of pieces that is already few; such products
 * get "Kończy się", and the ones to order are listed above.
 * Task 437: "CSV stanu magazynowego" — the list as a file for the supplier.
 * Task 438: "Dostawa" — the pieces that arrived are added to the stock by the server in one step.
 */
export function ProductsSection({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const p = t.products;
  const { location } = useSession();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [drafts, setDrafts] = useState<
    Record<string, { name: string; price: string; stock: string; low: string }>
  >({});
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [low, setLow] = useState('');
  const [deliveries, setDeliveries] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const show = (list: Product[]) => {
    setProducts(list);
    setDrafts(
      Object.fromEntries(
        list.map((x) => [
          x.id,
          {
            name: x.name,
            price: amountInput(x.priceGrosze),
            stock: stockInput(x.stockQuantity),
            low: stockInput(x.lowStockAt),
          },
        ]),
      ),
    );
  };

  const load = useCallback(async () => {
    try {
      show((await api<ProductList>(`${base}/products`)).products);
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(errorText(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Task 437: the stock list as a CSV file (the server names it). */
  async function downloadStock() {
    setBusy(true);
    setError('');
    try {
      const res = await apiResponse(`${base}/products/export.csv`, { query: { locale } });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await res.blob());
      link.download =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'stock.csv';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const newPrice = parseAmount(price);
  const newStock = parseStock(stock);
  const newLow = parseStock(low);
  const toOrder = (products ?? []).filter((x) => x.active && (x.lowStock || x.stockQuantity === 0));
  const canAdd =
    name.trim() !== '' &&
    price.trim() !== '' &&
    newPrice !== null &&
    newStock !== undefined &&
    newLow !== undefined &&
    !busy;

  return (
    <section className="page" data-testid="products">
      <h2>{p.title}</h2>
      <p className="small muted">{p.hint}</p>
      <p className="small muted">{p.stockHint}</p>
      <p className="small muted">{p.lowHint}</p>
      <p className="small muted">{p.restockHint}</p>
      <ErrorBox>{error}</ErrorBox>
      {toOrder.length > 0 ? (
        <p className="note" role="status" data-testid="products-to-order">
          {p.toOrder.replace(
            '{names}',
            toOrder
              .map(
                (x) =>
                  `${x.name} (${
                    x.stockQuantity === 0
                      ? p.stockNone
                      : p.stockLeft.replace('{n}', String(x.stockQuantity))
                  })`,
              )
              .join(', '),
          )}
        </p>
      ) : null}
      {products && products.length === 0 ? <p className="note">{p.empty}</p> : null}
      {products && products.length > 0 ? (
        <p>
          <button
            type="button"
            className="btn btn--quiet btn--small"
            title={p.stockCsvHint}
            disabled={busy}
            onClick={() => void downloadStock()}
          >
            {p.stockCsv}
          </button>
        </p>
      ) : null}
      {products && products.length > 0 ? (
        <ul className="commission-list">
          {products.map((x) => {
            const draft = drafts[x.id] ?? {
              name: x.name,
              price: amountInput(x.priceGrosze),
              stock: stockInput(x.stockQuantity),
              low: stockInput(x.lowStockAt),
            };
            const draftPrice = parseAmount(draft.price);
            const draftStock = parseStock(draft.stock);
            const draftLow = parseStock(draft.low);
            const changed =
              draft.name.trim() !== x.name ||
              (draftPrice !== null && draftPrice !== x.priceGrosze) ||
              (draftStock !== undefined && draftStock !== x.stockQuantity) ||
              (draftLow !== undefined && draftLow !== x.lowStockAt);
            return (
              <li key={x.id} className="commission-row" data-testid="product-row">
                <input
                  aria-label={`${p.name} — ${x.name}`}
                  value={draft.name}
                  maxLength={80}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [x.id]: { ...draft, name: e.target.value } })
                  }
                  style={{ flex: '1 1 12rem' }}
                />
                <span className="commission-row__input">
                  <input
                    inputMode="decimal"
                    aria-label={`${p.price} — ${x.name}`}
                    aria-invalid={draftPrice === null}
                    value={draft.price}
                    onChange={(e) =>
                      setDrafts({ ...drafts, [x.id]: { ...draft, price: e.target.value } })
                    }
                  />
                  <span aria-hidden="true">{location.currency}</span>
                </span>
                <span className="commission-row__input">
                  <input
                    inputMode="numeric"
                    aria-label={`${p.stock} — ${x.name}`}
                    aria-invalid={draftStock === undefined}
                    placeholder="—"
                    value={draft.stock}
                    onChange={(e) =>
                      setDrafts({ ...drafts, [x.id]: { ...draft, stock: e.target.value } })
                    }
                  />
                  <span aria-hidden="true">{p.pieces}</span>
                </span>
                <span className="commission-row__input">
                  <input
                    inputMode="numeric"
                    aria-label={`${p.low} — ${x.name}`}
                    aria-invalid={draftLow === undefined}
                    placeholder="—"
                    value={draft.low}
                    onChange={(e) =>
                      setDrafts({ ...drafts, [x.id]: { ...draft, low: e.target.value } })
                    }
                  />
                  <span aria-hidden="true">{p.pieces}</span>
                </span>
                <span className="commission-row__input">
                  <input
                    inputMode="numeric"
                    aria-label={`${p.restock} — ${x.name}`}
                    placeholder="+"
                    value={deliveries[x.id] ?? ''}
                    onChange={(e) => setDeliveries({ ...deliveries, [x.id]: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    aria-label={`${p.restockAdd} — ${x.name}`}
                    disabled={busy || !parseStock(deliveries[x.id] ?? '')}
                    onClick={() =>
                      void run(() =>
                        api(`${base}/products/${x.id}/restock`, {
                          method: 'POST',
                          body: { quantity: parseStock(deliveries[x.id] ?? '') },
                        }),
                      ).then((ok) => ok && setDeliveries({ ...deliveries, [x.id]: '' }))
                    }
                  >
                    {p.restockAdd}
                  </button>
                </span>
                {x.stockQuantity === 0 ? (
                  <span className="badge" data-testid="product-out">
                    {p.stockNone}
                  </span>
                ) : x.lowStock ? (
                  <span className="badge" data-testid="product-low">
                    {p.lowBadge}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={
                    busy ||
                    !changed ||
                    draftPrice === null ||
                    draftStock === undefined ||
                    draftLow === undefined ||
                    draft.name.trim() === ''
                  }
                  onClick={() =>
                    void run(() =>
                      api(`${base}/products/${x.id}`, {
                        method: 'PATCH',
                        body: {
                          name: draft.name.trim(),
                          priceGrosze: draftPrice,
                          stockQuantity: draftStock,
                          lowStockAt: draftLow,
                        },
                      }),
                    )
                  }
                >
                  {p.save}
                </button>
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={x.active}
                    disabled={busy}
                    onChange={(e) =>
                      void run(() =>
                        api(`${base}/products/${x.id}`, {
                          method: 'PATCH',
                          body: { active: e.target.checked },
                        }),
                      )
                    }
                  />
                  <span>{p.active}</span>
                </label>
                <button
                  type="button"
                  className="link-btn small"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(p.removeAsk.replace('{name}', x.name))) {
                      void run(() => api(`${base}/products/${x.id}`, { method: 'DELETE' }));
                    }
                  }}
                >
                  {p.remove}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form
        className="row"
        style={{ alignItems: 'end' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canAdd) return;
          void run(() =>
            api(`${base}/products`, {
              method: 'POST',
              body: {
                name: name.trim(),
                priceGrosze: newPrice,
                stockQuantity: newStock,
                lowStockAt: newLow,
              },
            }),
          ).then((ok) => {
            if (ok) {
              setName('');
              setPrice('');
              setStock('');
              setLow('');
            }
          });
        }}
      >
        <label className="field">
          <span>{p.newName}</span>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>
            {p.price} ({location.currency})
          </span>
          <input
            inputMode="decimal"
            value={price}
            aria-invalid={price !== '' && newPrice === null}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{p.stockNew}</span>
          <input
            inputMode="numeric"
            value={stock}
            placeholder="—"
            aria-invalid={newStock === undefined}
            onChange={(e) => setStock(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{p.lowNew}</span>
          <input
            inputMode="numeric"
            value={low}
            placeholder="—"
            aria-invalid={newLow === undefined}
            onChange={(e) => setLow(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--small" disabled={!canAdd}>
          + {p.add}
        </button>
      </form>
    </section>
  );
}
