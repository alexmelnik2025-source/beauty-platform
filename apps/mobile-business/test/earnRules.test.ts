import { describe, expect, it } from 'vitest';
import { BusinessApi } from '../src/api';
import { earnRows, earnServices, earnSummary, earnToSave, MAX_EARN } from '../src/earnRules';

const program = {
  earnRules: [
    { serviceId: 's1', serviceName: 'Strzyżenie', locationId: 'l1', points: 2 },
    { serviceId: 's9', serviceName: 'Stara usługa', locationId: 'l1', points: 0 },
    { serviceId: 'x1', serviceName: 'Inny salon', locationId: 'l2', points: 5 },
  ],
};
const active = [
  { id: 's1', name: 'Strzyżenie' },
  { id: 's2', name: 'Broda' },
];

describe('stamps and points per service (task 347)', () => {
  it('shows this salon’s numbers as typed', () => {
    expect(earnRows(program, 'l1')).toEqual({ s1: '2', s9: '0' });
    expect(earnRows(program, 'l3')).toEqual({});
  });

  it('keeps a switched-off service that has its own number in the list', () => {
    expect(earnServices(program, 'l1', active)).toEqual([
      { id: 's1', name: 'Strzyżenie' },
      { id: 's2', name: 'Broda' },
      { id: 's9', name: 'Stara usługa' },
    ]);
    expect(earnSummary(program, 'l1', earnServices(program, 'l1', active))).toEqual([
      { name: 'Strzyżenie', points: 2 },
      { name: 'Stara usługa', points: 0 },
    ]);
  });

  it('turns the fields into the list for the server; empty = the general rule', () => {
    expect(earnToSave({ s1: ' 3 ', s2: '', s9: '0' }, active)).toEqual({
      ok: true,
      save: {
        rules: [
          { serviceId: 's1', points: 3 },
          { serviceId: 's9', points: 0 },
        ],
      },
    });
    expect(earnToSave({}, active)).toEqual({ ok: true, save: { rules: [] } });
  });

  it('names the service with a wrong number', () => {
    expect(earnToSave({ s1: '2', s2: '1,5' }, active)).toEqual({ ok: false, service: 'Broda' });
    expect(earnToSave({ s2: '-1' }, active)).toEqual({ ok: false, service: 'Broda' });
    expect(earnToSave({ s1: String(MAX_EARN + 1) }, active)).toEqual({
      ok: false,
      service: 'Strzyżenie',
    });
    expect(earnToSave({ s1: String(MAX_EARN) }, active)).toMatchObject({ ok: true });
  });

  it('replaces the rules of one salon', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a1', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : { earnRules: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store = { get: async () => 'refresh-token-0123456789abc', set: async () => undefined };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.saveLoyaltyEarnRules('o1', 'l1', { rules: [{ serviceId: 's1', points: 2 }] });
    expect(calls.slice(1)).toEqual([
      {
        key: 'PUT /v1/organizations/o1/locations/l1/loyalty/earn-rules',
        body: { rules: [{ serviceId: 's1', points: 2 }] },
      },
    ]);
  });
});
