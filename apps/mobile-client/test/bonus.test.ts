import { describe, expect, it } from 'vitest';
import { ClientApi, type ClientLoyaltyCard, type TokenStore } from '../src/api';
import {
  earningText,
  formatDate,
  MAX_STAMPS_DRAWN,
  nextText,
  progress,
  readyReward,
  rewardText,
  signedPoints,
} from '../src/bonus';
import { DICTIONARIES, LOCALES } from '../src/i18n';

const pl = DICTIONARIES.pl;

function reward(
  id: string,
  cost: number,
  missing: number,
  extra: Partial<ClientLoyaltyCard['rewards'][number]> = {},
): ClientLoyaltyCard['rewards'][number] {
  return {
    id,
    name: `Nagroda ${id}`,
    kind: 'discount_percent',
    discountPercent: 25,
    freeServiceName: null,
    serviceNames: [],
    cost,
    missing,
    couponValidityDays: null,
    ...extra,
  };
}

function card(extra: Partial<ClientLoyaltyCard> = {}): ClientLoyaltyCard {
  return {
    organization: { id: 'o1', name: 'Gestalt Barbershop' },
    bookingSlug: 'gestalt',
    currency: 'PLN',
    enabled: true,
    mode: 'stamps',
    balance: 2,
    lifetimeEarned: 5,
    earning: {
      stampsPerVisit: 1,
      pointsPerUnit: 1,
      spendUnitGrosze: 1000,
      minSpendGrosze: 0,
      pointsValidityDays: null,
    },
    next: { rewardId: 'a', missing: 1, visits: 1 },
    rewards: [reward('a', 3, 1), reward('b', 6, 4)],
    coupons: [],
    history: [],
    ...extra,
  };
}

describe('"My bonuses" texts', () => {
  it('a stamp card: visits left to the next reward, one circle per stamp, rewards marked', () => {
    const c = card();
    expect(nextText(pl, c)).toBe('Do „Nagroda a” zostało wizyt: 1');
    expect(readyReward(c)).toBeUndefined();
    const p = progress(pl, c);
    expect(p?.kind).toBe('stamps');
    if (p?.kind !== 'stamps') return;
    expect(p.label).toBe('Zebrane: 2 z 6');
    expect(p.stamps).toHaveLength(6);
    expect(p.stamps.filter((s) => s.on)).toHaveLength(2);
    expect(p.stamps.map((s, i) => (s.reward ? i + 1 : 0)).filter(Boolean)).toEqual([3, 6]);
  });

  it('the best reward already reachable is offered; nothing next when all can be taken', () => {
    const c = card({
      balance: 6,
      next: null,
      rewards: [reward('a', 3, 0), reward('b', 6, 0)],
    });
    expect(readyReward(c)?.id).toBe('b');
    expect(nextText(pl, c)).toBeNull();
  });

  it('long cards and points are a bar to the next reward', () => {
    const long = progress(pl, card({ rewards: [reward('a', MAX_STAMPS_DRAWN + 3, 13)] }));
    expect(long?.kind).toBe('bar');
    const points = card({
      mode: 'points',
      balance: 40,
      next: { rewardId: 'b', missing: 60, visits: null },
      rewards: [reward('a', 30, 0), reward('b', 100, 60)],
    });
    expect(progress(pl, points)).toEqual({
      kind: 'bar',
      label: 'Zebrane: 40 z 100',
      value: 40,
      max: 100,
    });
    expect(nextText(pl, points)).toBe('Do „Nagroda b” zostało punktów: 60');
  });

  it('no rewards yet → no progress drawn', () => {
    expect(progress(pl, card({ rewards: [], next: null }))).toBeNull();
  });

  it('how bonuses are earned, with the minimum and validity of points', () => {
    expect(earningText(pl, card(), 'pl')).toBe('Pieczątki za opłaconą wizytę: 1');
    const points = card({
      mode: 'points',
      earning: {
        stampsPerVisit: 1,
        pointsPerUnit: 2,
        spendUnitGrosze: 1000,
        minSpendGrosze: 5000,
        pointsValidityDays: 365,
      },
    });
    const text = earningText(pl, points, 'pl').replace(/\s/g, ' ');
    expect(text).toMatch(
      /^2 pkt za każde 10,00 zł · od 50,00 zł za wizytę · punkty ważne 365 dni$/,
    );
  });

  it('what a reward gives, and signed history points', () => {
    expect(rewardText(pl, reward('a', 3, 0))).toBe('Zniżka 25%');
    expect(
      rewardText(pl, reward('a', 3, 0, { kind: 'free_service', freeServiceName: 'Broda' })),
    ).toBe('Gratis: Broda');
    expect(signedPoints(1)).toBe('+1');
    expect(signedPoints(-3)).toBe('-3');
    expect(formatDate('2026-11-04T10:00:00Z', 'en')).toBe('4 Nov 2026');
  });

  it('every language names every history type and coupon status', () => {
    for (const locale of LOCALES) {
      const b = DICTIONARIES[locale].bonuses;
      expect(Object.keys(b.type).sort(), locale).toEqual(
        ['adjust', 'earn', 'expire', 'redeem', 'reverse'].sort(),
      );
      expect(Object.keys(b.coupon).sort(), locale).toEqual(['active', 'expired', 'used']);
      expect(nextText(DICTIONARIES[locale], card()), locale).toContain('Nagroda a');
    }
  });
});

describe('ClientApi.loyalty', () => {
  it('asks for the bonuses signed in; without a session it does not call the server', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.authorization });
      if (url.endsWith('/v1/client/me')) {
        return new Response(JSON.stringify({ id: 'p1', email: 'a@example.com', locale: 'pl' }));
      }
      return new Response(JSON.stringify({ items: [card()] }));
    };
    const store: TokenStore = { get: async () => 'tok-0123456789', set: async () => {} };
    const signedOut = new ClientApi(
      'https://api.test',
      { get: async () => null, set: async () => {} },
      fetchFn,
    );
    await expect(signedOut.loyalty()).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(0);

    const api = new ClientApi('https://api.test', store, fetchFn);
    await api.restore();
    const res = await api.loyalty();
    expect(res.items[0]?.organization.name).toBe('Gestalt Barbershop');
    expect(calls.at(-1)).toEqual({
      url: 'https://api.test/v1/client/loyalty',
      auth: 'Bearer tok-0123456789',
    });
  });
});
