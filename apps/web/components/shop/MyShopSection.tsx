'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { PHOTO_ACCEPT, shrinkPhoto, STAFF_PHOTO_SIDE } from '@/lib/photos';
import { formatPrice } from '@/lib/time';
import type { CatalogProduct, CatalogSearch, Product, ProductList } from '@/lib/types';
import { parseTip as parseAmount } from '../calendar/TipField';
import { useSession } from '../Session';
import { ReservationDays } from './ReservationDays';
import { ErrorBox, Spinner } from '../ui';

const SHOP_CATEGORIES = [
  'hair_care',
  'styling',
  'beard',
  'skin_care',
  'tools',
  'accessories',
  'gifts',
  'other',
] as const;
type ShopCategory = (typeof SHOP_CATEGORIES)[number];
type ShopFilter = 'all' | 'salon' | 'market' | 'hidden';

/** Which filter a product belongs to: in the "Sklep", on the salon page only, or hidden. */
function statusOf(p: Product): Exclude<ShopFilter, 'all'> {
  if (p.inSalonShop && p.inMarketplace) return 'market';
  return p.inSalonShop ? 'salon' : 'hidden';
}

/**
 * Task Q3 (part 2a): "Mój sklep" — the salon's own shop in the cabinet. Every product of the
 * salon's list is here with two switches: "Pokaż klientom na stronie salonu" (clients buy it and
 * pick it up at a visit) and "Sprzedawaj też w Sklepie" (every client of the platform sees it in
 * the "Sklep" tab). The second one needs a card in the platform catalogue: "Wybierz z katalogu"
 * finds one by words or the code on the package (the same card for every salon that sells the
 * product), "Nowa karta" makes one from the product's name. Prices and stock stay in "Usługi" →
 * "Produkty"; a quick "Dodaj produkt" here adds a product already shown to clients.
 * Part 2b: the card's picture — "Dodaj zdjęcie" (shrunk in the browser like a staff portrait) when
 * the salon may set it: it made the card and is alone on it, or the shared card has none yet.
 * At the launch clients only pick up and pay at the salon — nothing about shipping is shown.
 * At the bottom: how many days a product put aside for a visit waits after it (`ReservationDays`).
 */
export function MyShopSection({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const s = t.shop;
  const { location, role } = useSession();
  const tag = LOCALE_TAGS[locale];
  const [products, setProducts] = useState<Product[] | null>(null);
  /** The cards of the products that have one, by card id. */
  const [cards, setCards] = useState<Record<string, CatalogProduct>>({});
  /** The product whose "Wybierz z katalogu" is open, the words typed and what was found. */
  const [picking, setPicking] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<CatalogProduct[] | null>(null);
  const [newCard, setNewCard] = useState<{ brand: string; ean: string; category: ShopCategory }>({
    brand: '',
    ean: '',
    category: 'other',
  });
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Task Q6: the list as in a shop admin — search, filters, one row per product, opened in place. */
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState<ShopFilter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const list = await api<ProductList>(`${base}/products`);
    setProducts(list.products);
    const ids = [...new Set(list.products.map((p) => p.catalogProductId).filter(Boolean))];
    const got = await Promise.all(
      ids.map((id) => api<CatalogProduct>(`${base}/shop/catalog/${id}`).catch(() => null)),
    );
    setCards(
      Object.fromEntries(got.filter((c): c is CatalogProduct => c !== null).map((c) => [c.id, c])),
    );
  }, [base]);

  useEffect(() => {
    load().catch((e: unknown) => setError(errorText(t, e)));
  }, [load, t]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      // Also after an error: the switches go back to what the server has.
      await load().catch(() => undefined);
      setBusy(false);
    }
  };

  /** The switches flip at once (the list is reloaded after the server answered). */
  const patch = (id: string, body: Partial<Product>) => {
    setProducts((list) => list && list.map((p) => (p.id === id ? { ...p, ...body } : p)));
    return run(() => api(`${base}/products/${id}`, { method: 'PATCH', body }));
  };

  const setPhoto = (cardId: string, file: File | undefined) =>
    file
      ? run(async () => {
          const blob = await shrinkPhoto(file, STAFF_PHOTO_SIDE);
          await api(`${base}/shop/catalog/${cardId}/photo`, { method: 'PUT', file: blob });
        })
      : undefined;

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setFound(null);
      return;
    }
    try {
      const res = await api<CatalogSearch>(`${base}/shop/catalog`, { query: { q: q.trim() } });
      setFound(res.products);
    } catch (e) {
      setError(errorText(t, e));
    }
  };

  const openPicker = (product: Product) => {
    setPicking(product.id);
    setFound(null);
    setNewCard({ brand: '', ean: product.barcode ?? '', category: 'other' });
    void search(product.name);
  };

  const makeCard = (product: Product) =>
    run(async () => {
      const ean = newCard.ean.replace(/[\s-]+/g, '');
      const card = await api<CatalogProduct>(`${base}/shop/catalog`, {
        method: 'POST',
        body: {
          name: product.name,
          brand: newCard.brand.trim() || null,
          ean: ean || null,
          category: newCard.category,
        },
      });
      await api(`${base}/products/${product.id}`, {
        method: 'PATCH',
        body: { catalogProductId: card.id },
      });
      setPicking(null);
    });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const priceGrosze = parseAmount(price);
    const stockQuantity = stock.trim() === '' ? null : Number(stock);
    if (
      !name.trim() ||
      priceGrosze === null ||
      (stockQuantity !== null && !/^\d{1,6}$/.test(stock.trim()))
    ) {
      setError(s.addInvalid);
      return;
    }
    await run(async () => {
      await api(`${base}/products`, {
        method: 'POST',
        body: { name: name.trim(), priceGrosze, stockQuantity, inSalonShop: true },
      });
      setName('');
      setPrice('');
      setStock('');
      setAdding(false);
    });
  };

  if (!products) return error ? <ErrorBox>{error}</ErrorBox> : <Spinner />;

  const shown = products.filter((p) => p.active);
  const inShop = shown.filter((p) => p.inSalonShop).length;

  const counts: Record<ShopFilter, number> = {
    all: shown.length,
    salon: shown.filter((p) => statusOf(p) === 'salon').length,
    market: shown.filter((p) => statusOf(p) === 'market').length,
    hidden: shown.filter((p) => statusOf(p) === 'hidden').length,
  };
  const words = filterText.trim().toLowerCase();
  const visible = shown.filter(
    (p) =>
      (filter === 'all' || statusOf(p) === filter) &&
      (!words || p.name.toLowerCase().includes(words) || (p.barcode ?? '').includes(words)),
  );
  const statusText = (p: Product) =>
    ({ market: s.filterMarket, salon: s.filterSalon, hidden: s.statusHidden })[statusOf(p)];

  return (
    <section className="stack" aria-labelledby="my-shop-title">
      {/* Task Q6: a title, "?" for the explanations and one main button — as in a shop admin. */}
      <div className="row shop-head">
        <div className="title-help">
          <h1 id="my-shop-title">{s.title}</h1>
          <button
            type="button"
            className="help-btn"
            aria-label={s.helpOpen}
            title={s.helpOpen}
            aria-expanded={helpOpen}
            aria-controls="my-shop-help"
            onClick={() => setHelpOpen((v) => !v)}
          >
            ?
          </button>
        </div>
        <button
          type="button"
          className="btn"
          aria-expanded={adding}
          aria-controls="shop-add"
          onClick={() => setAdding((v) => !v)}
        >
          {s.addOpen}
        </button>
      </div>
      {helpOpen ? (
        <div id="my-shop-help" className="help-box">
          <p className="small muted">{s.hint}</p>
          <p className="small muted">{s.pickupOnly}</p>
        </div>
      ) : null}
      {role !== 'staff' ? (
        <p className="small">
          <Link href={`/${locale}/app/shop/integrations`} data-testid="my-shop-integrations">
            {t.products.integrationsLink}
          </Link>
        </p>
      ) : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {adding ? (
        <form
          className="card stack"
          id="shop-add"
          onSubmit={(e) => void add(e)}
          aria-labelledby="shop-add-title"
        >
          <h2 id="shop-add-title" className="h3">
            {s.add}
          </h2>
          <p className="small muted">{s.addHint}</p>
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field">
              <span>{t.products.name}</span>
              <input
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              <span>{t.products.price}</span>
              <input
                value={price}
                inputMode="decimal"
                required
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label className="field">
              <span>{s.stock}</span>
              <input value={stock} inputMode="numeric" onChange={(e) => setStock(e.target.value)} />
            </label>
            <button type="submit" className="btn" disabled={busy}>
              {t.common.save}
            </button>
          </div>
        </form>
      ) : null}

      <p className="small">
        {fill(s.summary, { shown: String(inShop), all: String(shown.length) })}
      </p>

      {shown.length === 0 ? (
        <p className="muted">{s.empty}</p>
      ) : (
        <div className="card shop-list">
          <div className="shop-tools">
            <input
              type="search"
              value={filterText}
              aria-label={s.listSearch}
              placeholder={s.listSearch}
              onChange={(e) => setFilterText(e.target.value)}
            />
            <div className="shop-filters" role="group" aria-label={s.listSearch}>
              {(['all', 'salon', 'market', 'hidden'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className="shop-filter"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {
                    {
                      all: s.filterAll,
                      salon: s.filterSalon,
                      market: s.filterMarket,
                      hidden: s.filterHidden,
                    }[f]
                  }{' '}
                  <span className="muted">{counts[f]}</span>
                </button>
              ))}
            </div>
          </div>
          {visible.length === 0 ? <p className="small muted">{s.noMatch}</p> : null}
          <ul className="shop-rows" aria-label={s.title}>
            {visible.map((x) => {
              const card = x.catalogProductId ? cards[x.catalogProductId] : undefined;
              const canMarket = x.inSalonShop && Boolean(x.catalogProductId);
              const status = statusOf(x);
              return (
                <li key={x.id} data-testid={`shop-product-${x.id}`}>
                  <button
                    type="button"
                    className="shop-row"
                    aria-expanded={open === x.id}
                    aria-label={fill(s.details, { name: x.name })}
                    onClick={() => setOpen(open === x.id ? null : x.id)}
                  >
                    {card?.photoId ? (
                      <img
                        className="shop-row__thumb"
                        src={`/v1/public/photos/${card.photoId}`}
                        alt=""
                        width={40}
                        height={40}
                      />
                    ) : (
                      <span className="shop-row__thumb" aria-hidden="true">
                        {x.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="shop-row__name">
                      <strong>{x.name}</strong>
                      <span className={`status-pill status-pill--${status}`}>{statusText(x)}</span>
                    </span>
                    <span className="shop-row__stock muted">
                      {x.stockQuantity !== null
                        ? fill(s.pieces, { n: String(x.stockQuantity) })
                        : '—'}
                    </span>
                    <span className="shop-row__price">
                      {formatPrice(x.priceGrosze, location.currency, tag)}
                    </span>
                  </button>
                  {open === x.id ? (
                    <div className="stack shop-row__more">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={x.inSalonShop}
                          disabled={busy}
                          onChange={(e) =>
                            void patch(x.id, {
                              inSalonShop: e.target.checked,
                              ...(e.target.checked ? {} : { inMarketplace: false }),
                            })
                          }
                        />
                        <span>{s.inSalonShop}</span>
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={x.inMarketplace}
                          disabled={busy || !canMarket}
                          onChange={(e) => void patch(x.id, { inMarketplace: e.target.checked })}
                        />
                        <span>{s.inMarketplace}</span>
                      </label>
                      {!canMarket ? (
                        <p className="small muted">
                          {!x.inSalonShop ? s.marketNeedsSalonShop : s.marketNeedsCard}
                        </p>
                      ) : null}
                      {card ? (
                        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
                          {card.photoId ? (
                            <img
                              src={`/v1/public/photos/${card.photoId}`}
                              alt={fill(s.photoAlt, { name: card.name })}
                              width={64}
                              height={64}
                              style={{ objectFit: 'cover', borderRadius: 8 }}
                            />
                          ) : null}
                          {card.editable || card.photoId === null ? (
                            <label
                              className={`btn btn--quiet btn--small${busy ? ' is-disabled' : ''}`}
                            >
                              {card.photoId ? s.photoChange : s.photoAdd}
                              <input
                                type="file"
                                accept={PHOTO_ACCEPT}
                                className="visually-hidden"
                                disabled={busy}
                                aria-label={fill(s.photoFor, { name: card.name })}
                                onChange={(e) => void setPhoto(card.id, e.target.files?.[0])}
                              />
                            </label>
                          ) : null}
                          {card.photoId && card.editable ? (
                            <button
                              type="button"
                              className="link-btn small"
                              disabled={busy}
                              onClick={() =>
                                void run(() =>
                                  api(`${base}/shop/catalog/${card.id}/photo`, {
                                    method: 'DELETE',
                                  }),
                                )
                              }
                            >
                              {s.photoRemove}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      <p className="small">
                        {card ? (
                          <>
                            {s.card}: <strong>{card.name}</strong>
                            {card.brand ? ` · ${card.brand}` : ''}
                            {card.ean ? ` · EAN ${card.ean}` : ''}
                            {card.sellers > 1
                              ? ` · ${fill(s.sellers, { n: String(card.sellers) })}`
                              : ''}{' '}
                            <button
                              type="button"
                              className="link-btn small"
                              disabled={busy}
                              onClick={() =>
                                void patch(x.id, { catalogProductId: null, inMarketplace: false })
                              }
                            >
                              {s.unlink}
                            </button>
                          </>
                        ) : (
                          <>
                            {s.noCard}{' '}
                            <button
                              type="button"
                              className="link-btn small"
                              aria-expanded={picking === x.id}
                              disabled={busy}
                              onClick={() => (picking === x.id ? setPicking(null) : openPicker(x))}
                            >
                              {s.pick}
                            </button>
                          </>
                        )}
                      </p>
                      {picking === x.id ? (
                        <div className="stack" style={{ gap: 8 }}>
                          <label className="field">
                            <span>{s.search}</span>
                            <input
                              type="search"
                              value={query}
                              autoFocus
                              onChange={(e) => void search(e.target.value)}
                            />
                          </label>
                          {found && found.length > 0 ? (
                            <ul className="list" aria-label={s.found}>
                              {found.map((c) => (
                                <li
                                  key={c.id}
                                  className="row"
                                  style={{ justifyContent: 'space-between' }}
                                >
                                  <span>
                                    {c.name}
                                    {c.brand ? ` · ${c.brand}` : ''}
                                    {c.ean ? ` · EAN ${c.ean}` : ''}
                                    {c.sellers > 0
                                      ? ` · ${fill(s.sellers, { n: String(c.sellers) })}`
                                      : ''}
                                  </span>
                                  <button
                                    type="button"
                                    className="btn btn--small"
                                    disabled={busy}
                                    onClick={() =>
                                      void run(async () => {
                                        await api(`${base}/products/${x.id}`, {
                                          method: 'PATCH',
                                          body: { catalogProductId: c.id },
                                        });
                                        setPicking(null);
                                      })
                                    }
                                  >
                                    {s.choose}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : found ? (
                            <p className="small muted">{s.nothingFound}</p>
                          ) : null}
                          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                            <label className="field">
                              <span>{s.brand}</span>
                              <input
                                value={newCard.brand}
                                maxLength={60}
                                onChange={(e) => setNewCard({ ...newCard, brand: e.target.value })}
                              />
                            </label>
                            <label className="field">
                              <span>{s.ean}</span>
                              <input
                                value={newCard.ean}
                                inputMode="numeric"
                                maxLength={18}
                                onChange={(e) => setNewCard({ ...newCard, ean: e.target.value })}
                              />
                            </label>
                            <label className="field">
                              <span>{s.category}</span>
                              <select
                                value={newCard.category}
                                onChange={(e) =>
                                  setNewCard({
                                    ...newCard,
                                    category: e.target.value as ShopCategory,
                                  })
                                }
                              >
                                {SHOP_CATEGORIES.map((c) => (
                                  <option key={c} value={c}>
                                    {s.categories[c]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="btn btn--quiet"
                              disabled={busy}
                              onClick={() => void makeCard(x)}
                            >
                              {fill(s.newCard, { name: x.name })}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <ReservationDays base={base} />
    </section>
  );
}
