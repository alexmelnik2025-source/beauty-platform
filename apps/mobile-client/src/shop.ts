import type { ShopCategory, ShopOffer, ShopProduct } from './api';

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
  if (offers.length === 0) return null;
  if (offers.length === 1) return { kind: 'one', salon: offers[0]!.salon.name };
  return { kind: 'many', n: new Set(offers.map((o) => o.salon.slug)).size };
}

/** The currency of the cheapest available offer (the API's `fromPriceGrosze` is in it). */
export function fromCurrency(product: ShopProduct): string {
  return (availableOffers(product)[0] ?? product.offers[0])?.currency ?? 'PLN';
}
