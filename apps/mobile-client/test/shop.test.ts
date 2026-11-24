import { describe, expect, it } from 'vitest';
import { ClientApi, type ClientAppointment, type ShopProduct, type TokenStore } from '../src/api';
import {
  availableOffers,
  fromCurrency,
  nextVisitAt,
  sellersLine,
  SHOP_CATEGORIES,
} from '../src/shop';
import { DICTIONARIES, LOCALES } from '../src/i18n';

const store: TokenStore = { get: async () => null, set: async () => undefined };

const offer = (slug: string, priceGrosze: number, available = true) => ({
  productId: `p-${slug}-${priceGrosze}`,
  priceGrosze,
  currency: 'PLN',
  available,
  fulfillment: ['pickup_at_salon' as const],
  salon: { slug, name: `Salon ${slug}`, city: 'Warszawa', addressLine: 'ul. Bema 1' },
});

const product = (offers: ReturnType<typeof offer>[]): ShopProduct => ({
  id: 'card-1',
  name: 'Pomada matowa',
  brand: 'Reuzel',
  ean: null,
  description: null,
  category: 'styling',
  photoId: null,
  fromPriceGrosze: 4900,
  offers,
});

describe('"Sklep" in the client app (task Q3, screen 2)', () => {
  it('asks the public shop without signing in, with the search and the category', async () => {
    const calls: string[] = [];
    const list = { products: [], total: 0, page: 1, pageSize: 24 };
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url.replace('https://api.test', '')}`);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      return new Response(JSON.stringify(url.includes('/products/') ? product([]) : list));
    };
    const api = new ClientApi('https://api.test', store, fetchFn);
    await api.shop();
    await api.shop({ q: '  pomada ', category: 'beard', page: 2 });
    await api.shop({ q: '   ' });
    await api.shopProduct('card 1');
    expect(calls).toEqual([
      'GET /v1/public/shop/products?page=1&pageSize=24',
      'GET /v1/public/shop/products?page=2&pageSize=24&q=pomada&category=beard',
      'GET /v1/public/shop/products?page=1&pageSize=24',
      'GET /v1/public/shop/products/card%201',
    ]);
  });

  it('names the one salon selling it, counts several, says when none has it', () => {
    expect(sellersLine(product([offer('a', 4900)]))).toEqual({ kind: 'one', salon: 'Salon a' });
    expect(
      sellersLine(product([offer('a', 4900), offer('b', 5500), offer('c', 6000, false)])),
    ).toEqual({ kind: 'many', n: 2 });
    expect(sellersLine(product([offer('a', 4900, false)]))).toBeNull();
    expect(availableOffers(product([offer('a', 1, false), offer('b', 2)]))).toHaveLength(1);
    expect(fromCurrency(product([{ ...offer('a', 1), currency: 'EUR' }]))).toBe('EUR');
    expect(fromCurrency(product([]))).toBe('PLN');
  });

  it('distinguishes a product without a price quote from a free offer', () => {
    // The API sends zero for the starting price when it has no offers to price.
    const unpriced = { ...product([]), fromPriceGrosze: 0 };
    const free = { ...unpriced, offers: [offer('a', 0)] };
    expect(availableOffers(unpriced)).toEqual([]);
    expect(sellersLine(unpriced)).toBeNull();
    expect(availableOffers(free)).toEqual(free.offers);
    expect(sellersLine(free)).toEqual({ kind: 'one', salon: 'Salon a' });
  });

  it('names a single salon even when it has two offers for the same product', () => {
    expect(sellersLine(product([offer('a', 4900), offer('a', 5500)]))).toEqual({
      kind: 'one',
      salon: 'Salon a',
    });
  });

  it('has every category and line of the shop in all six languages', () => {
    for (const l of LOCALES) {
      const shop = DICTIONARIES[l].shop;
      for (const c of SHOP_CATEGORIES) expect(shop.categories[c], `${l}.${c}`).toBeTruthy();
      expect(shop.from).toContain('{price}');
      expect(shop.salons).toContain('{n}');
    }
  });
});

describe('"Odbiorę przy wizycie" from a product (task Q3)', () => {
  const NOW = Date.parse('2026-11-20T10:00:00Z');
  const visit = (id: string, slug: string, start: string, status = 'confirmed') =>
    ({ id, status, start, salon: { slug } }) as unknown as ClientAppointment;

  it('takes my soonest confirmed visit ahead at that salon', () => {
    const visits = [
      visit('later', 'bema', '2026-11-28T09:00:00Z'),
      visit('other-salon', 'wola', '2026-11-21T09:00:00Z'),
      visit('soon', 'bema', '2026-11-22T15:00:00Z'),
      visit('past', 'bema', '2026-11-20T09:00:00Z'),
      visit('cancelled', 'bema', '2026-11-21T08:00:00Z', 'cancelled'),
      visit('waiting', 'bema', '2026-11-21T07:00:00Z', 'held'),
    ];
    expect(nextVisitAt(visits, 'bema', NOW)?.id).toBe('soon');
    expect(nextVisitAt(visits, 'wola', NOW)?.id).toBe('other-salon');
  });

  it('is null without a visit ahead there — the offer shows only "Umów wizytę"', () => {
    expect(nextVisitAt([], 'bema', NOW)).toBeNull();
    expect(nextVisitAt([visit('past', 'bema', '2026-11-19T09:00:00Z')], 'bema', NOW)).toBeNull();
  });

  it('has the texts in every language', () => {
    for (const l of LOCALES) {
      expect(DICTIONARIES[l].shop.reserve).toContain('{when}');
      expect(DICTIONARIES[l].shop.reserved).toContain('{when}');
    }
  });
});
