import {
  ClientApi,
  type ClientAppointment,
  type ShopCategory,
  type ShopOffer,
  type ShopProduct,
  type ShopList,
  type TokenStore,
  type VisitProducts,
  type UsedProducts,
} from './api';

/**
 * Task Q3 (screen 2): the "Sklep" tab of the client app. Plain helpers without React Native, so
 * they are tested with Vitest (test/shop.test.ts).
 */

/** The category chips, in the order the client sees them (same list as the API). */
export const SHOP_CATEGORIES: ShopCategory[] = [
  'hair_care',
  'styling',
  'beard',
  'skin_care',
  'tools',
  'accessories',
  'gifts',
  'other',
];

/** Offers the client can pick up now: available ones only, cheapest first (as the API sends). */
export function availableOffers(product: ShopProduct): ShopOffer[] {
  return product.offers.filter((o) => o.available);
}

/**
 * What one line under the product's name says: the one salon selling it, or how many do —
 * `null` when no salon has it right now (the card then says "Chwilowo brak").
 */
export function sellersLine(
  product: ShopProduct,
): { kind: 'one'; salon: string } | { kind: 'many'; n: number } | null {
  const offers = availableOffers(product);
  const first = offers[0];
  if (!first) return null;
  const salonCount = new Set(offers.map((o) => o.salon.slug)).size;
  return salonCount === 1
    ? { kind: 'one', salon: first.salon.name }
    : { kind: 'many', n: salonCount };
}

/** The currency of the cheapest available offer (the API's `fromPriceGrosze` is in it). */
export function fromCurrency(product: ShopProduct): string {
  return (availableOffers(product)[0] ?? product.offers[0])?.currency ?? 'PLN';
}

/**
 * Task Q3: "Odbiorę przy wizycie" from a product's page — my soonest visit at this salon that a
 * product can still be put aside for (confirmed and not started yet, as the API checks); `null`
 * when there is none, and the offer then shows only "Umów wizytę".
 */
export function nextVisitAt(
  visits: ClientAppointment[],
  salonSlug: string,
  now = Date.now(),
): ClientAppointment | null {
  let best: ClientAppointment | null = null;
  for (const v of visits) {
    if (v.salon.slug !== salonSlug || v.status !== 'confirmed') continue;
    const start = Date.parse(v.start);
    if (!(start > now)) continue;
    if (!best || start < Date.parse(best.start)) best = v;
  }
  return best;
}

/** Keep recent reads across a quick return. Rejections and invalidated reads can be retried. */
export function recentReads<T>() {
  const clients = new WeakMap<ClientApi, Map<string, { result: Promise<T>; until: number }>>();
  function clear(api: ClientApi, key?: string) {
    if (key === undefined) clients.delete(api);
    else clients.get(api)?.delete(key);
  }
  function read(api: ClientApi, key: string, fetchData: () => Promise<T>) {
    let entries = clients.get(api);
    if (!entries) {
      entries = new Map();
      clients.set(api, entries);
    }
    const cached = entries.get(key);
    if (cached && cached.until > Date.now()) return cached.result;
    const result = fetchData();
    entries.delete(key);
    if (entries.size >= 32) entries.delete(entries.keys().next().value!);
    entries.set(key, { result, until: Date.now() + 30_000 });
    result.catch(() => {
      if (entries.get(key)?.result === result) entries.delete(key);
    });
    return result;
  }
  return { read, clear };
}

export const catalogPages = recentReads<ShopList>();
export const visitProductLists = recentReads<VisitProducts>();
export const usedProductLists = recentReads<UsedProducts>();

/** A reservation changes availability in the catalog and in both types of visit card. */
export function invalidateProductLists(api: ClientApi) {
  catalogPages.clear(api);
  visitProductLists.clear(api);
  usedProductLists.clear(api);
}

/** Use the existing public shop endpoint and error handling with a cancellable transport. */
export function searchShop(
  baseUrl: string,
  store: TokenStore,
  query: Parameters<ClientApi['shop']>[0],
  signal: AbortSignal,
) {
  const publicApi = new ClientApi(baseUrl, store, (url, init) => fetch(url, { ...init, signal }));
  return publicApi.shop(query);
}
