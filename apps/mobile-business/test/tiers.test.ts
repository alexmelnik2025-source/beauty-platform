import { describe, expect, it } from 'vitest';
import { BusinessApi, type LoyaltyTiers } from '../src/api';
import { MAX_TIERS, tierRows, tiersToSave, type TierRow } from '../src/tiers';

const row = (name: string, threshold: string, discountPercent = '0'): TierRow => ({
  name,
  threshold,
  discountPercent,
});

describe('customer tiers (task 345)', () => {
  it('shows saved tiers as typed: visits as they are, amounts in the currency', () => {
    const data: LoyaltyTiers = {
      basis: 'spend',
      periodDays: 365,
      tiers: [
        { id: 't1', name: 'Silver', threshold: 50000, discountPercent: 5 },
        { id: 't2', name: 'Gold', threshold: 99950, discountPercent: 10 },
      ],
    };
    expect(tierRows(data)).toEqual([row('Silver', '500', '5'), row('Gold', '999,50', '10')]);
    expect(
      tierRows({ ...data, basis: 'visits', tiers: [{ ...data.tiers[0]!, threshold: 5 }] }),
    ).toEqual([row('Silver', '5', '5')]);
  });

  it('turns the rows into the list for the server', () => {
    expect(
      tiersToSave('spend', ' 180 ', [row(' Silver ', '500'), row('Gold', '999,5', '')]),
    ).toEqual({
      ok: true,
      save: {
        basis: 'spend',
        periodDays: 180,
        tiers: [
          { name: 'Silver', threshold: 50000, discountPercent: 0 },
          { name: 'Gold', threshold: 99950, discountPercent: 0 },
        ],
      },
    });
    expect(tiersToSave('visits', '365', [])).toEqual({
      ok: true,
      save: { basis: 'visits', periodDays: 365, tiers: [] },
    });
  });

  it('points out the period, the row and what is wrong in it', () => {
    expect(tiersToSave('visits', '29', [])).toEqual({ ok: false, problem: 'period' });
    expect(tiersToSave('visits', '1096', [])).toEqual({ ok: false, problem: 'period' });
    expect(tiersToSave('visits', '365', [row('A', '1'), row(' ', '2')])).toEqual({
      ok: false,
      problem: 'name',
      row: 1,
    });
    expect(tiersToSave('visits', '365', [row('A', '1,5')])).toMatchObject({ problem: 'threshold' });
    expect(tiersToSave('visits', '365', [row('A', '')])).toMatchObject({ problem: 'threshold' });
    expect(tiersToSave('visits', '365', [row('A', '1', '101')])).toMatchObject({
      problem: 'discount',
    });
    expect(tiersToSave('visits', '365', [row('A', '5'), row('B', '5')])).toEqual({
      ok: false,
      problem: 'same',
      row: 1,
    });
    const many = Array.from({ length: MAX_TIERS + 1 }, (_, i) => row(`T${i}`, String(i)));
    expect(tiersToSave('visits', '365', many)).toEqual({ ok: false, problem: 'tooMany' });
  });

  it('reads and replaces the tiers', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a1', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : { basis: 'visits', periodDays: 365, tiers: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store = { get: async () => 'refresh-token-0123456789abc', set: async () => undefined };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.loyaltyTiers('o1');
    await api.saveLoyaltyTiers('o1', { basis: 'visits', periodDays: 365, tiers: [] });
    expect(calls.slice(1)).toEqual([
      { key: 'GET /v1/organizations/o1/loyalty/tiers', body: undefined },
      {
        key: 'PUT /v1/organizations/o1/loyalty/tiers',
        body: { basis: 'visits', periodDays: 365, tiers: [] },
      },
    ]);
  });
});
