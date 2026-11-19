'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiResponse } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import { orderText, toOrderNames } from '@/lib/to-order';
import type { Product, ProductList, StockHistory } from '@/lib/types';
import { useSession } from '../Session';
import { ErrorBox } from '../ui';
import { parseTip as parseAmount } from '../calendar/TipField';
import { StocktakePanel } from './StocktakePanel';

/** "" → null (not counted), "12" → 12; anything else → undefined (wrong). Task 430. */
function parseStock(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) <= 100_000 ? Number(text) : undefined;
}

const stockInput = (n: number | null) => (n === null ? '' : String(n));

/** Task 448: "" → null (not written), "20,50" → 2050; anything else → undefined (wrong). */
function parseCost(value: string): number | null | undefined {
  if (value.trim() === '') return null;
  return parseAmount(value) ?? undefined;
}

const costInput = (n: number | null) => (n === null ? '' : amountInput(n));

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
 * Task 442: "Wartość magazynu" — what the pieces in stock are worth at the selling prices.
 * Task 441: "Historia" — the product's last stock changes (sale, delivery, by hand), who and when.
 * Task 457: "Inwentaryzacja" — the numbers counted on the shelf for all products at once.
 * Task 448: "Cena zakupu" — what the salon pays for one (empty = not written); the stock value is
 * also shown at these prices, and the report counts the margin of the products sold.
 * Task 463: "Dostawca" — whom the salon orders the product from; the stock CSV for one supplier.
 * Task 473: "Tekst zamówienia" — the products to order as a message for each supplier, with
 * suggested numbers of pieces; the owner changes what they like and copies it.
 */
export function ProductsSection({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const p = t.products;
  const { location } = useSession();
  const [products, setProducts] = useState<Product[] | null>(null);
  /** Task 461: pieces sold at the visits of the last 30 days, by product. */
  const [sold30, setSold30] = useState<Map<string, number>>(new Map());
  const [drafts, setDrafts] = useState<
    Record<
      string,
      { name: string; price: string; cost: string; stock: string; low: string; supplier: string }
    >
  >({});
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [stock, setStock] = useState('');
  const [low, setLow] = useState('');
  const [supplier, setSupplier] = useState('');
  /** Task 463: "" = the stock CSV of all suppliers. */
  const [csvSupplier, setCsvSupplier] = useState('');
  /** Task 470: the stock CSV with only the products to order. */
  const [csvToOrder, setCsvToOrder] = useState(false);
  const [historyOf, setHistoryOf] = useState<{
    id: string;
    rows: StockHistory['movements'];
  } | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, string>>({});
  const [writeOff, setWriteOff] = useState({ quantity: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stocktake, setStocktake] = useState(false);
  const [stocktakeDone, setStocktakeDone] = useState('');
  /** Task 473: the order text being prepared (null = closed) and what copying it said. */
  const [order, setOrder] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState('');

  const show = (list: Product[]) => {
    setProducts(list);
    setDrafts(
      Object.fromEntries(
        list.map((x) => [
          x.id,
          {
            name: x.name,
            price: amountInput(x.priceGrosze),
            cost: costInput(x.purchasePriceGrosze),
            stock: stockInput(x.stockQuantity),
            low: stockInput(x.lowStockAt),
            supplier: x.supplier ?? '',
          },
        ]),
      ),
    );
  };

  const load = useCallback(async () => {
    try {
      const list = await api<ProductList>(`${base}/products`);
      setSold30(new Map(list.sold30Days.map((x) => [x.productId, x.quantity])));
      show(list.products);
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
      if (historyOf) {
        // The open history shows the change too (gone with a removed product).
        const res = await api<StockHistory>(`${base}/products/${historyOf.id}/stock-history`).catch(
          () => null,
        );
        setHistoryOf(res ? { id: historyOf.id, rows: res.movements } : null);
      }
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
      const res = await apiResponse(`${base}/products/export.csv`, {
        query: {
          locale,
          ...(csvFor ? { supplier: csvFor } : {}),
          ...(csvToOrder ? { toOrder: 'true' } : {}),
        },
      });
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

  async function toggleHistory(id: string) {
    if (historyOf?.id === id) {
      setHistoryOf(null);
      return;
    }
    setError('');
    setWriteOff({ quantity: '', note: '' });
    try {
      const res = await api<StockHistory>(`${base}/products/${id}/stock-history`);
      setHistoryOf({ id, rows: res.movements });
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  const newPrice = parseAmount(price);
  const newCost = parseCost(cost);
  const newStock = parseStock(stock);
  const newLow = parseStock(low);
  const counted = (products ?? []).filter((x) => x.stockQuantity !== null);
  const stockPieces = counted.reduce((n, x) => n + (x.stockQuantity ?? 0), 0);
  const stockValue = counted.reduce((sum, x) => sum + (x.stockQuantity ?? 0) * x.priceGrosze, 0);
  // Task 448: at purchase prices — only when every counted product has one.
  const stockCost = counted.every((x) => x.purchasePriceGrosze !== null)
    ? counted.reduce((sum, x) => sum + (x.stockQuantity ?? 0) * (x.purchasePriceGrosze ?? 0), 0)
    : null;
  /** Task 461: "Sprzedano w 30 dni: 3 szt. · starczy na ~20 dni" — how fast it sells. */
  const pace = (x: Product): string | null => {
    const n = sold30.get(x.id);
    if (!n) return null;
    const days =
      x.stockQuantity !== null && x.stockQuantity > 0
        ? Math.floor((x.stockQuantity * 30) / n)
        : null;
    return [
      fill(p.sold30, { n: String(n) }),
      days === null ? '' : fill(p.lastsDays, { days: String(days) }),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  /** Task 463: the suppliers written at the products, each once (any letter case), by name. */
  const suppliers = [
    ...new Map(
      (products ?? [])
        .filter((x) => x.supplier !== null)
        .map((x) => [x.supplier!.toLocaleLowerCase(), x.supplier!]),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
  const csvFor = suppliers.includes(csvSupplier) ? csvSupplier : '';
  const toOrder = (products ?? []).filter((x) => x.active && (x.lowStock || x.stockQuantity === 0));
  const canAdd =
    name.trim() !== '' &&
    price.trim() !== '' &&
    newPrice !== null &&
    newCost !== undefined &&
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
      <p className="small muted">{p.writeOffHint}</p>
      <p className="small muted">{p.costHint}</p>
      <p className="small muted">{p.supplierHint}</p>
      <ErrorBox>{error}</ErrorBox>
      {toOrder.length > 0 ? (
        <p className="note" role="status" data-testid="products-to-order">
          {p.toOrder.replace(
            '{names}',
            toOrderNames(
              toOrder,
              (x) =>
                x.stockQuantity === 0
                  ? p.stockNone
                  : p.stockLeft.replace('{n}', String(x.stockQuantity)),
              p.toOrderNoSupplier,
            ),
          )}
        </p>
      ) : null}
      {toOrder.length > 0 ? (
        <div data-testid="products-order">
          <button
            type="button"
            className="btn btn--quiet btn--small"
            aria-expanded={order !== null}
            onClick={() => {
              setOrderStatus('');
              setOrder(
                order !== null
                  ? null
                  : orderText(toOrder, sold30, {
                      title: p.orderTitle,
                      noSupplier: p.toOrderNoSupplier,
                      pieces: p.orderPieces,
                    }),
              );
            }}
          >
            {p.orderOpen}
          </button>
          {order !== null ? (
            <>
              <p className="small muted">{p.orderHint}</p>
              <textarea
                aria-label={p.orderOpen}
                value={order}
                rows={Math.min(order.split('\n').length + 1, 16)}
                style={{ width: '100%', maxWidth: 560, fontFamily: 'inherit' }}
                onChange={(e) => {
                  setOrder(e.target.value);
                  setOrderStatus('');
                }}
              />
              <p>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    const text = order;
                    void (async () => {
                      try {
                        await navigator.clipboard.writeText(text);
                        setOrderStatus(p.orderCopied);
                      } catch {
                        setOrderStatus(p.orderCopyFailed);
                      }
                    })();
                  }}
                >
                  {p.orderCopy}
                </button>{' '}
                <span className="small" role="status">
                  {orderStatus}
                </span>
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      {counted.length > 0 ? (
        <p className="small" data-testid="products-stock-value">
          {p.stockValue
            .replace('{amount}', formatPrice(stockValue, location.currency, LOCALE_TAGS[locale]))
            .replace('{n}', String(stockPieces))}
          {stockCost !== null
            ? ` ${p.stockCostValue.replace(
                '{amount}',
                formatPrice(stockCost, location.currency, LOCALE_TAGS[locale]),
              )}`
            : ''}
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
          </button>{' '}
          {suppliers.length > 0 ? (
            <>
              <select
                aria-label={p.supplierCsv}
                value={csvFor}
                disabled={busy}
                onChange={(e) => setCsvSupplier(e.target.value)}
              >
                <option value="">{p.supplierAll}</option>
                {suppliers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>{' '}
            </>
          ) : null}
          <label className="check small">
            <input
              type="checkbox"
              checked={csvToOrder}
              disabled={busy}
              onChange={(e) => setCsvToOrder(e.target.checked)}
            />{' '}
            {p.csvToOrder}
          </label>{' '}
          <button
            type="button"
            className="btn btn--quiet btn--small"
            aria-expanded={stocktake}
            disabled={busy}
            onClick={() => {
              setStocktake(!stocktake);
              setStocktakeDone('');
            }}
          >
            {p.stocktake}
          </button>
        </p>
      ) : null}
      {stocktakeDone ? (
        <p className="note" role="status" data-testid="stocktake-done">
          {stocktakeDone}
        </p>
      ) : null}
      {stocktake && products && products.length > 0 ? (
        <StocktakePanel
          base={base}
          products={products}
          onSaved={(result) => {
            show(result.products);
            setStocktake(false);
            setHistoryOf(null);
            setStocktakeDone(
              p.stocktakeDone
                .replace('{changed}', String(result.changed))
                .replace('{missing}', String(result.missingPieces))
                .replace('{extra}', String(result.extraPieces)),
            );
          }}
        />
      ) : null}
      {products && products.length > 0 ? (
        <ul className="commission-list">
          {products.map((x) => {
            const draft = drafts[x.id] ?? {
              name: x.name,
              price: amountInput(x.priceGrosze),
              cost: costInput(x.purchasePriceGrosze),
              stock: stockInput(x.stockQuantity),
              low: stockInput(x.lowStockAt),
              supplier: x.supplier ?? '',
            };
            const draftPrice = parseAmount(draft.price);
            const draftCost = parseCost(draft.cost);
            const draftStock = parseStock(draft.stock);
            const draftLow = parseStock(draft.low);
            const changed =
              draft.name.trim() !== x.name ||
              (draftPrice !== null && draftPrice !== x.priceGrosze) ||
              (draftCost !== undefined && draftCost !== x.purchasePriceGrosze) ||
              (draftStock !== undefined && draftStock !== x.stockQuantity) ||
              (draftLow !== undefined && draftLow !== x.lowStockAt) ||
              (draft.supplier.trim() || null) !== x.supplier;
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
                    inputMode="decimal"
                    aria-label={`${p.cost} — ${x.name}`}
                    aria-invalid={draftCost === undefined}
                    placeholder={p.costPlaceholder}
                    value={draft.cost}
                    onChange={(e) =>
                      setDrafts({ ...drafts, [x.id]: { ...draft, cost: e.target.value } })
                    }
                  />
                  <span aria-hidden="true">{location.currency}</span>
                </span>
                <input
                  aria-label={`${p.supplier} — ${x.name}`}
                  placeholder={p.supplier}
                  value={draft.supplier}
                  maxLength={80}
                  onChange={(e) =>
                    setDrafts({ ...drafts, [x.id]: { ...draft, supplier: e.target.value } })
                  }
                  style={{ flex: '0 1 9rem', minWidth: 0 }}
                />
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
                {pace(x) ? (
                  <span className="small muted" data-testid="product-pace">
                    {pace(x)}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={
                    busy ||
                    !changed ||
                    draftPrice === null ||
                    draftCost === undefined ||
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
                          purchasePriceGrosze: draftCost,
                          stockQuantity: draftStock,
                          lowStockAt: draftLow,
                          supplier: draft.supplier.trim() || null,
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
                  aria-expanded={historyOf?.id === x.id}
                  aria-label={p.historyFor.replace('{name}', x.name)}
                  onClick={() => void toggleHistory(x.id)}
                >
                  {p.history}
                </button>
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
                {historyOf?.id === x.id ? (
                  <div style={{ flexBasis: '100%' }} data-testid="stock-history">
                    <h3 className="small">{p.historyFor.replace('{name}', x.name)}</h3>
                    {x.stockQuantity !== null && x.stockQuantity > 0 ? (
                      // Task 444: "Odpis" — used in the salon, damaged or lost.
                      <div
                        style={{
                          display: 'flex',
                          gap: '0.5rem',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          marginBottom: '0.5rem',
                        }}
                        data-testid="stock-write-off"
                      >
                        <span className="commission-row__input">
                          <input
                            inputMode="numeric"
                            aria-label={`${p.writeOffQuantity} — ${x.name}`}
                            placeholder="−"
                            value={writeOff.quantity}
                            onChange={(e) => setWriteOff({ ...writeOff, quantity: e.target.value })}
                          />
                          <span aria-hidden="true">{p.pieces}</span>
                        </span>
                        <input
                          aria-label={p.writeOffNote}
                          placeholder={p.writeOffNote}
                          maxLength={120}
                          value={writeOff.note}
                          onChange={(e) => setWriteOff({ ...writeOff, note: e.target.value })}
                        />
                        <button
                          type="button"
                          className="btn btn--quiet btn--small"
                          aria-label={p.writeOffFor.replace('{name}', x.name)}
                          disabled={busy || !parseStock(writeOff.quantity)}
                          onClick={() =>
                            void run(() =>
                              api(`${base}/products/${x.id}/write-off`, {
                                method: 'POST',
                                body: {
                                  quantity: parseStock(writeOff.quantity),
                                  ...(writeOff.note.trim() ? { note: writeOff.note.trim() } : {}),
                                },
                              }),
                            ).then((ok) => ok && setWriteOff({ quantity: '', note: '' }))
                          }
                        >
                          {p.writeOffAdd}
                        </button>
                      </div>
                    ) : null}
                    {historyOf.rows.length === 0 ? (
                      <p className="small muted">{p.historyEmpty}</p>
                    ) : (
                      <ul className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
                        {historyOf.rows.map((r) => (
                          <li key={r.id}>
                            {r.date} {r.time} · {p.historyKinds[r.kind]} ·{' '}
                            {p.historyRow
                              .replace('{change}', r.change > 0 ? `+${r.change}` : String(r.change))
                              .replace(
                                '{after}',
                                r.quantityAfter === null
                                  ? p.historyNotCounted
                                  : String(r.quantityAfter),
                              )}
                            {r.byName ? ` · ${r.byName}` : ''}
                            {r.note ? ` · ${r.note}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
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
                purchasePriceGrosze: newCost,
                stockQuantity: newStock,
                lowStockAt: newLow,
                supplier: supplier.trim() || null,
              },
            }),
          ).then((ok) => {
            if (ok) {
              setName('');
              setPrice('');
              setCost('');
              setStock('');
              setLow('');
              setSupplier('');
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
          <span>
            {p.costNew} ({location.currency})
          </span>
          <input
            inputMode="decimal"
            value={cost}
            placeholder="—"
            aria-invalid={newCost === undefined}
            onChange={(e) => setCost(e.target.value)}
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
        <label className="field">
          <span>{p.supplierNew}</span>
          <input
            value={supplier}
            maxLength={80}
            placeholder="—"
            onChange={(e) => setSupplier(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--small" disabled={!canAdd}>
          + {p.add}
        </button>
      </form>
    </section>
  );
}
