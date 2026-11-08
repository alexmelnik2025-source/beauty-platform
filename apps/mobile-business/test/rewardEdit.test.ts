import { describe, expect, it } from 'vitest';
import { BusinessApi, type LoyaltyReward } from '../src/api';
import { DICTIONARIES, fill } from '../src/i18n';
import {
  EMPTY_REWARD_FULL,
  rewardForm,
  rewardLimits,
  rewardToSave,
  rewardUpdate,
  toggledService,
} from '../src/rewardEdit';

const reward: LoyaltyReward = {
  id: 'r1',
  name: 'Broda gratis',
  kind: 'free_service',
  discountPercent: null,
  freeServiceId: 's2',
  cost: 8,
  serviceIds: ['s2'],
  couponValidityDays: 30,
  sortOrder: 3,
  archivedAt: null,
  version: 4,
} as LoyaltyReward;

describe('changing a reward (task 348)', () => {
  it('gives a saved reward its form back', () => {
    expect(rewardForm(reward)).toEqual({
      name: 'Broda gratis',
      kind: 'free_service',
      percent: '',
      serviceId: 's2',
      cost: '8',
      validityDays: '30',
      serviceIds: ['s2'],
    });
    expect(
      rewardForm({
        ...reward,
        kind: 'discount_percent',
        discountPercent: 25,
        couponValidityDays: null,
      }),
    ).toMatchObject({ percent: '25', validityDays: '' });
  });

  it('checks the coupon validity and keeps the chosen services', () => {
    const form = { ...EMPTY_REWARD_FULL, name: '−25%', percent: '25', cost: '5' };
    expect(rewardToSave(form)).toEqual({
      ok: true,
      reward: {
        name: '−25%',
        kind: 'discount_percent',
        discountPercent: 25,
        freeServiceId: null,
        cost: 5,
        couponValidityDays: null,
        serviceIds: [],
      },
    });
    expect(rewardToSave({ ...form, validityDays: ' 60 ', serviceIds: ['s1', 's1'] })).toMatchObject(
      { ok: true, reward: { couponValidityDays: 60, serviceIds: ['s1'] } },
    );
    expect(rewardToSave({ ...form, validityDays: '0' })).toEqual({
      ok: false,
      problem: 'validity',
    });
    expect(rewardToSave({ ...form, validityDays: '3651' })).toEqual({
      ok: false,
      problem: 'validity',
    });
    expect(rewardToSave({ ...form, validityDays: '1,5' })).toEqual({
      ok: false,
      problem: 'validity',
    });
    expect(rewardToSave({ ...form, name: '' })).toEqual({ ok: false, problem: 'name' });
  });

  it('keeps the place in the list and sends the version read', () => {
    const checked = rewardToSave(rewardForm(reward));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(rewardUpdate(reward, checked.reward)).toMatchObject({ sortOrder: 3, version: 4 });
    expect(toggledService(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggledService(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('describes the coupon limits', () => {
    const l = DICTIONARIES.pl.loyalty;
    const names = new Map([['s2', 'Broda']]);
    expect(rewardLimits(reward, names, l, fill)).toBe('kupon ważny 30 dni · tylko: Broda');
    expect(rewardLimits({ couponValidityDays: null, serviceIds: ['x'] }, names, l, fill)).toBe(
      'tylko: usługa innego salonu',
    );
    expect(rewardLimits({ couponValidityDays: null, serviceIds: [] }, names, l, fill)).toBeNull();
    for (const dict of Object.values(DICTIONARIES)) {
      expect(dict.loyalty.problem.validity).toBeTruthy();
    }
  });

  it('saves the whole reward with PUT', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a1', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : reward;
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store = { get: async () => 'refresh-token-0123456789abc', set: async () => undefined };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    const body = {
      name: 'Broda gratis',
      kind: 'free_service' as const,
      discountPercent: null,
      freeServiceId: 's2',
      cost: 8,
      couponValidityDays: 30,
      serviceIds: ['s2'],
      sortOrder: 3,
      version: 4,
    };
    await api.updateLoyaltyReward('o1', 'r1', body);
    expect(calls.slice(1)).toEqual([{ key: 'PUT /v1/organizations/o1/loyalty/rewards/r1', body }]);
  });
});
