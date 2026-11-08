import { describe, expect, it } from 'vitest';
import { ApiError, BusinessApi, type LoyaltyAccount, type LoyaltyReward } from '../src/api';
import {
  bonusErrorText,
  cancellableCoupons,
  parseAdjustment,
  rewardChoices,
  showBonusCard,
} from '../src/clientBonus';
import { DICTIONARIES } from '../src/i18n';

const pl = DICTIONARIES.pl;

const reward = (id: string, over: Partial<LoyaltyReward> = {}): LoyaltyReward => ({
  id,
  name: id,
  kind: 'discount_percent',
  discountPercent: 25,
  freeServiceId: null,
  cost: 5,
  serviceIds: [],
  couponValidityDays: null,
  sortOrder: 0,
  archivedAt: null,
  version: 1,
  ...over,
});

type Coupon = LoyaltyAccount['coupons'][number];
const coupon = (id: string, over: Partial<Coupon> = {}): Coupon => ({
  id,
  code: `K-${id}`,
  rewardId: 'r1',
  name: '−25%',
  kind: 'discount_percent',
  discountPercent: 25,
  freeServiceId: null,
  serviceIds: [],
  cost: 5,
  status: 'active',
  expiresAt: null,
  usedAt: null,
  usedAppointmentId: null,
  cancelledAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  version: 1,
  ...over,
});

describe('a manual change of the balance', () => {
  it('takes signed whole numbers and a reason of at least 3 characters', () => {
    expect(parseAdjustment(' +5 ', ' Prezent ')).toEqual({
      ok: true,
      points: 5,
      reason: 'Prezent',
    });
    expect(parseAdjustment('-2', 'Błąd')).toEqual({ ok: true, points: -2, reason: 'Błąd' });
    expect(parseAdjustment('−3', 'Błąd')).toEqual({ ok: true, points: -3, reason: 'Błąd' });
  });

  it('points out zero, fractions, words and too big numbers', () => {
    for (const bad of ['', '0', '1.5', 'pięć', '100001', '-100001', '--1']) {
      expect(parseAdjustment(bad, 'Powód')).toEqual({ ok: false, problem: 'points' });
    }
  });

  it('points out a missing or too long reason', () => {
    expect(parseAdjustment('5', ' ab ')).toEqual({ ok: false, problem: 'reason' });
    expect(parseAdjustment('5', 'x'.repeat(501))).toEqual({ ok: false, problem: 'reason' });
  });
});

describe('rewards to exchange', () => {
  it('cheaper first, removed ones left out, "enough" from the balance', () => {
    const list = rewardChoices({ balance: 6 }, [
      reward('big', { cost: 10 }),
      reward('gone', { archivedAt: '2026-11-01T00:00:00.000Z' }),
      reward('small', { cost: 6 }),
    ]);
    expect(list.map((c) => [c.reward.id, c.enough])).toEqual([
      ['small', true],
      ['big', false],
    ]);
  });
});

describe('coupons to cancel', () => {
  it('only active coupons that have not run out', () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    const account = {
      coupons: [
        coupon('a'),
        coupon('b', { status: 'used' }),
        coupon('c', { expiresAt: '2026-11-07T23:00:00.000Z' }),
        coupon('d', { expiresAt: '2026-12-01T00:00:00.000Z' }),
        coupon('e', { status: 'cancelled' }),
      ],
    };
    expect(cancellableCoupons(account, now).map((c) => c.id)).toEqual(['a', 'd']);
  });
});

describe('when the card is shown', () => {
  const empty = { balance: 0, lifetimeEarned: 0, coupons: [], transactions: [] };
  it('always while the program is on; when off, only with something to show', () => {
    expect(showBonusCard(empty, true)).toBe(true);
    expect(showBonusCard(empty, false)).toBe(false);
    expect(showBonusCard({ ...empty, balance: 3 }, false)).toBe(true);
    expect(showBonusCard({ ...empty, coupons: [coupon('a')] }, false)).toBe(true);
  });
});

describe('errors in words', () => {
  it('not enough, program off, coupon already used or changed', () => {
    const b = pl.clients.bonus;
    expect(bonusErrorText(new ApiError(409, 'x', 'LOYALTY_NOT_ENOUGH'), pl)).toBe(b.notEnough);
    expect(bonusErrorText(new ApiError(409, 'x', 'LOYALTY_DISABLED'), pl)).toBe(b.disabled);
    expect(bonusErrorText(new ApiError(409, 'x', 'COUPON_NOT_ACTIVE'), pl)).toBe(b.changed);
    expect(bonusErrorText(new ApiError(409, 'x', 'VERSION_CONFLICT'), pl)).toBe(b.changed);
    expect(bonusErrorText(new ApiError(500, 'x'), pl)).toBeNull();
    expect(bonusErrorText(new Error('offline'), pl)).toBeNull();
  });
});

describe('the API calls', () => {
  it('exchange, manual change and cancel go to the organisation’s loyalty paths', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (key === 'POST /v1/auth/refresh') {
        return new Response(
          JSON.stringify({
            accessToken: 'a1',
            expiresIn: 900,
            refreshToken: 'refresh-token-0123456789abcd',
            user: {
              id: 'u1',
              email: 'k@example.com',
              name: 'K',
              locale: 'pl',
              emailVerified: true,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ code: 'K7QM-4XTB' }), { status: 201 });
    };
    let saved: string | null = 'refresh-token-0123456789abc';
    const api = new BusinessApi(
      'https://api.test',
      {
        get: async () => saved,
        set: async (v) => {
          saved = v;
        },
      },
      fetchFn,
    );
    await api.restore();
    await api.redeemLoyaltyReward('o1', 'c1', 'r1');
    await api.adjustLoyaltyBalance('o1', 'c1', -2, 'Pomyłka');
    await api.cancelLoyaltyCoupon('o1', 'k1', 3);
    expect(calls.slice(1)).toEqual([
      {
        key: 'POST /v1/organizations/o1/loyalty/accounts/c1/redemptions',
        body: { rewardId: 'r1' },
      },
      {
        key: 'POST /v1/organizations/o1/loyalty/accounts/c1/adjustments',
        body: { points: -2, reason: 'Pomyłka' },
      },
      { key: 'POST /v1/organizations/o1/loyalty/coupons/k1/cancel', body: { version: 3 } },
    ]);
  });
});
