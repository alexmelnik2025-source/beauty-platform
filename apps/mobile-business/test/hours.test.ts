import { describe, expect, it } from 'vitest';
import { BusinessApi, type StaffList, type TokenStore } from '../src/api';
import {
  hoursInput,
  hoursOff,
  parseDayHours,
  specialBody,
  specialInput,
  teamForHours,
  weekInputs,
  weeklyBody,
} from '../src/hours';

describe('one day of working hours', () => {
  it('reads short and full times, dashes and commas; empty is a day off', () => {
    expect(parseDayHours('9-14, 15-20')).toEqual([
      { start: '09:00', end: '14:00' },
      { start: '15:00', end: '20:00' },
    ]);
    expect(parseDayHours(' 15:30–20:00 , 09:00 - 14:00 ')).toEqual([
      { start: '09:00', end: '14:00' },
      { start: '15:30', end: '20:00' },
    ]);
    expect(parseDayHours('18-24')).toEqual([{ start: '18:00', end: '24:00' }]);
    expect(parseDayHours('')).toEqual([]);
    expect(parseDayHours('   ')).toEqual([]);
  });

  it('rejects what the server would reject', () => {
    expect(parseDayHours('14-9')).toBeNull();
    expect(parseDayHours('9-9')).toBeNull();
    expect(parseDayHours('9-14, 13-18')).toBeNull();
    expect(parseDayHours('9:75-14')).toBeNull();
    expect(parseDayHours('25-26')).toBeNull();
    expect(parseDayHours('rano')).toBeNull();
    expect(parseDayHours('9')).toBeNull();
    expect(parseDayHours('1-2,3-4,5-6,7-8,9-10,11-12,13-14')).toBeNull();
  });

  it('shows the hours as they are typed back', () => {
    expect(hoursInput([])).toBe('');
    expect(
      hoursInput([
        { start: '09:00', end: '14:00' },
        { start: '15:00', end: '20:00' },
      ]),
    ).toBe('09:00–14:00, 15:00–20:00');
  });
});

describe('the week', () => {
  it('fills the fields Monday to Sunday and sends only working days', () => {
    const inputs = weekInputs({
      weekly: [
        { weekday: 1, intervals: [{ start: '10:00', end: '18:00' }] },
        { weekday: 6, intervals: [{ start: '09:00', end: '14:00' }] },
      ],
    });
    expect(inputs).toEqual({
      1: '10:00–18:00',
      2: '',
      3: '',
      4: '',
      5: '',
      6: '09:00–14:00',
      7: '',
    });
    expect(weeklyBody({ ...inputs, 2: '12-20' })).toEqual({
      ok: true,
      days: [
        { weekday: 1, intervals: [{ start: '10:00', end: '18:00' }] },
        { weekday: 2, intervals: [{ start: '12:00', end: '20:00' }] },
        { weekday: 6, intervals: [{ start: '09:00', end: '14:00' }] },
      ],
    });
    expect(weeklyBody({ ...inputs, 3: '20-12' })).toEqual({ ok: false, weekday: 3 });
  });

  it('lists active specialists in the salon order', () => {
    const staff = [
      { id: 'b', displayName: 'Bartek', sortOrder: 2, active: true },
      { id: 'x', displayName: 'Ex', sortOrder: 0, active: false },
      { id: 'a', displayName: 'Ola', sortOrder: 1, active: true },
      { id: 'k', displayName: 'Kasia', sortOrder: 1, active: true },
    ] as StaffList;
    expect(teamForHours(staff).map((s) => s.id)).toEqual(['k', 'a', 'b']);
  });
});

describe('a special day (task 335)', () => {
  it('needs at least one interval: a whole day off is time off', () => {
    expect(specialBody('10-14')).toEqual({
      ok: true,
      intervals: [{ start: '10:00', end: '14:00' }],
    });
    expect(specialBody('  ')).toEqual({ ok: false, problem: 'empty' });
    expect(specialBody('14-10')).toEqual({ ok: false, problem: 'bad' });
  });

  it('shows the hours the date already has', () => {
    const hours = {
      overrides: [{ date: '2026-12-24', intervals: [{ start: '09:00', end: '13:00' }] }],
    };
    expect(specialInput(hours, '2026-12-24')).toBe('09:00–13:00');
    expect(specialInput(hours, '2026-12-23')).toBe('');
  });
});

describe('time off for a part of a day (task 338)', () => {
  it('one interval on that date; 24:00 ends at the next midnight', () => {
    expect(hoursOff('2026-12-24', '12-15')).toEqual({
      start: '2026-12-24T12:00',
      end: '2026-12-24T15:00',
    });
    expect(hoursOff('2026-12-31', '20:00–24:00')).toEqual({
      start: '2026-12-31T20:00',
      end: '2027-01-01T00:00',
    });
  });

  it('nothing, two intervals or a wrong time cannot be read', () => {
    expect(hoursOff('2026-12-24', '')).toBeNull();
    expect(hoursOff('2026-12-24', '9-10, 12-13')).toBeNull();
    expect(hoursOff('2026-12-24', '15-12')).toBeNull();
  });
});

describe('BusinessApi working hours', () => {
  it('replaces the weekly hours of a specialist', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a9', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : { timezone: 'Europe/Warsaw', weekly: [], overrides: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    const days = [{ weekday: 1, intervals: [{ start: '09:00', end: '17:00' }] }];
    await api.setWorkingHours('o1', 'l1', 's1', days);
    expect(calls.slice(1)).toEqual([
      { key: 'PUT /v1/organizations/o1/locations/l1/staff/s1/working-hours', body: { days } },
    ]);
  });

  it('sets and removes the special hours of a date', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a9', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : { timezone: 'Europe/Warsaw', weekly: [], overrides: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    const intervals = [{ start: '10:00', end: '14:00' }];
    await api.setSpecialDay('o1', 'l1', 's1', '2026-12-24', intervals);
    await api.removeSpecialDay('o1', 'l1', 's1', '2026-12-24');
    const path = '/v1/organizations/o1/locations/l1/staff/s1/working-hours/overrides/2026-12-24';
    expect(calls.slice(1)).toEqual([
      { key: `PUT ${path}`, body: { intervals } },
      { key: `DELETE ${path}`, body: undefined },
    ]);
  });
});
