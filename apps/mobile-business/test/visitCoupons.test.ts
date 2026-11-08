import { describe, expect, it } from 'vitest';
import { ApiError, BusinessApi, type AppointmentDetail } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import { couponCode, couponErrorText, hasCoupons, mayUseCoupons } from '../src/visitCoupons';

const pl = DICTIONARIES.pl;
type Visit = Pick<AppointmentDetail, 'customer' | 'paidAt' | 'status'>;
const visit = (over: Partial<Visit> = {}): Visit => ({
  customer: { id: 'c1' } as AppointmentDetail['customer'],
  paidAt: null,
  status: 'confirmed',
  ...over,
});

describe('coupons on a visit (task 343)', () => {
  it('only a booked or "came" visit of a client, not paid, for someone who may change it', () => {
    expect(mayUseCoupons(visit(), true)).toBe(true);
    expect(mayUseCoupons(visit({ status: 'completed' }), true)).toBe(true);
    expect(mayUseCoupons(visit(), false)).toBe(false);
    expect(mayUseCoupons(visit({ customer: null }), true)).toBe(false);
    expect(mayUseCoupons(visit({ paidAt: '2026-11-08T12:00:00.000Z' }), true)).toBe(false);
    expect(mayUseCoupons(visit({ status: 'cancelled' }), true)).toBe(false);
    expect(mayUseCoupons(visit({ status: 'no_show' }), true)).toBe(false);
  });

  it('shows the card only with a tier or a coupon', () => {
    expect(hasCoupons({ tier: null, applied: [], available: [] })).toBe(false);
    expect(
      hasCoupons({
        tier: {
          name: 'Gold',
          discountPercent: 10,
          discountGrosze: 900,
          applied: false,
          problem: null,
        },
        applied: [],
        available: [],
      }),
    ).toBe(true);
  });

  it('reads a code as the client says it', () => {
    expect(couponCode(' k7qm-4xtb ')).toBe('K7QM-4XTB');
    expect(couponCode('k7 qm')).toBe('K7QM');
    expect(couponCode('abc')).toBeNull();
    expect(couponCode('x'.repeat(21))).toBeNull();
  });

  it('says why the server refused', () => {
    const e = pl.visit.coupons.error;
    const err = (code: string) => new ApiError(409, 'x', code);
    expect(couponErrorText(new ApiError(404, 'x', 'NOT_FOUND'), pl)).toBe(e.notFound);
    expect(couponErrorText(err('COUPON_EXPIRED'), pl)).toBe(e.expired);
    expect(couponErrorText(err('COUPON_NOT_FOR_SERVICE'), pl)).toBe(e.notForService);
    expect(couponErrorText(err('COUPON_NOT_COMBINABLE'), pl)).toBe(e.notCombinable);
    expect(couponErrorText(err('COUPON_NO_DISCOUNT'), pl)).toBe(e.noDiscount);
    expect(couponErrorText(err('TIER_NO_DISCOUNT'), pl)).toBe(e.noDiscount);
    expect(couponErrorText(err('COUPON_NOT_ACTIVE'), pl)).toBe(e.notActive);
    expect(couponErrorText(err('VISIT_NOT_CHANGEABLE'), pl)).toBe(e.notChangeable);
    expect(couponErrorText(err('VERSION_CONFLICT'), pl)).toBeNull();
    expect(couponErrorText(new Error('offline'), pl)).toBeNull();
  });

  it('calls the visit’s coupon paths with the version read', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a1', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : {};
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store = { get: async () => 'refresh-token-0123456789abc', set: async () => undefined };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.visitCoupons('o1', 'l1', 'a1');
    await api.applyVisitCoupon('o1', 'l1', 'a1', 3, { couponId: 'k1' });
    await api.applyVisitCoupon('o1', 'l1', 'a1', 4, { code: 'K7QM-4XTB' });
    await api.removeVisitCoupon('o1', 'l1', 'a1', 5, 'k1');
    await api.setTierDiscount('o1', 'l1', 'a1', 6, true);
    await api.setTierDiscount('o1', 'l1', 'a1', 7, false);
    const base = '/v1/organizations/o1/locations/l1/appointments/a1';
    expect(calls.slice(1)).toEqual([
      { key: `GET ${base}/coupons`, body: undefined },
      { key: `POST ${base}/coupons`, body: { version: 3, couponId: 'k1' } },
      { key: `POST ${base}/coupons`, body: { version: 4, code: 'K7QM-4XTB' } },
      { key: `POST ${base}/coupons/k1/remove`, body: { version: 5 } },
      { key: `POST ${base}/tier-discount`, body: { version: 6 } },
      { key: `POST ${base}/tier-discount/remove`, body: { version: 7 } },
    ]);
  });
});
