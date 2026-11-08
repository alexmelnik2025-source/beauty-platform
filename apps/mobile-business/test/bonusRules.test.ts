import { describe, expect, it } from 'vitest';
import { BusinessApi } from '../src/api';
import {
  bonusGives,
  bonusRows,
  bonusToSave,
  EMPTY_BONUS,
  MAX_BONUS_RULES,
  toggled,
} from '../src/bonusRules';

describe('extra stamps and points (task 346)', () => {
  it('shows saved rules as typed', () => {
    expect(
      bonusRows({
        rules: [
          {
            id: 'r1',
            name: 'Spokojne dni',
            staff: [{ id: 's1', displayName: 'Kasia' }],
            weekdays: [1, 2, 3],
            multiplier: 2,
            extraPoints: 0,
            withinDays: null,
          },
        ],
      }),
    ).toEqual([
      {
        name: 'Spokojne dni',
        staffIds: ['s1'],
        weekdays: [1, 2, 3],
        multiplier: '2',
        extraPoints: '0',
        withinDays: '',
      },
    ]);
  });

  it('turns the rows into the list for the server', () => {
    expect(
      bonusToSave([
        { ...EMPTY_BONUS, name: ' Spokojne dni ', weekdays: [3, 1, 3], staffIds: ['s1'] },
        { ...EMPTY_BONUS, name: 'Wróć szybko', multiplier: '', extraPoints: '5', withinDays: '30' },
      ]),
    ).toEqual({
      ok: true,
      save: {
        rules: [
          {
            name: 'Spokojne dni',
            staffIds: ['s1'],
            weekdays: [1, 3],
            multiplier: 2,
            extraPoints: 0,
            withinDays: null,
          },
          {
            name: 'Wróć szybko',
            staffIds: [],
            weekdays: [],
            multiplier: 1,
            extraPoints: 5,
            withinDays: 30,
          },
        ],
      },
    });
  });

  it('points out the row and what is wrong', () => {
    const ok = { ...EMPTY_BONUS, name: 'A' };
    const problem = (over: Partial<typeof ok>) => bonusToSave([ok, { ...ok, ...over }]);
    expect(problem({ name: ' ' })).toEqual({ ok: false, problem: 'name', row: 1 });
    expect(problem({ multiplier: '11' })).toMatchObject({ problem: 'multiplier' });
    expect(problem({ multiplier: '0' })).toMatchObject({ problem: 'multiplier' });
    expect(problem({ extraPoints: '-1' })).toMatchObject({ problem: 'extra' });
    expect(problem({ multiplier: '1', extraPoints: '0' })).toMatchObject({ problem: 'nothing' });
    expect(problem({ withinDays: '366' })).toMatchObject({ problem: 'within' });
    expect(problem({ withinDays: 'x' })).toMatchObject({ problem: 'within' });
    const many = Array.from({ length: MAX_BONUS_RULES + 1 }, () => ok);
    expect(bonusToSave(many)).toEqual({ ok: false, problem: 'tooMany' });
  });

  it('says what a rule gives and toggles choices', () => {
    expect(bonusGives({ multiplier: 2, extraPoints: 0 })).toBe('×2');
    expect(bonusGives({ multiplier: 3, extraPoints: 5 })).toBe('×3 · +5');
    expect(bonusGives({ multiplier: 1, extraPoints: 5 })).toBe('+5');
    expect(toggled([1, 2], 2)).toEqual([1]);
    expect(toggled([1], 2)).toEqual([1, 2]);
  });

  it('reads and replaces the rules', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a1', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : { rules: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store = { get: async () => 'refresh-token-0123456789abc', set: async () => undefined };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.loyaltyBonusRules('o1');
    await api.saveLoyaltyBonusRules('o1', { rules: [] });
    expect(calls.slice(1)).toEqual([
      { key: 'GET /v1/organizations/o1/loyalty/bonus-rules', body: undefined },
      { key: 'PUT /v1/organizations/o1/loyalty/bonus-rules', body: { rules: [] } },
    ]);
  });
});
