import { describe, expect, it } from 'vitest';
import {
  BusinessApi,
  type SalonWaitlist,
  type ServiceList,
  type StaffList,
  type TokenStore,
} from '../src/api';
import {
  presetChoice,
  presetFromEntry,
  waitlistOfDay,
  waitlistStatus,
  type WaitlistEntry,
} from '../src/waitlist';

const entry = (over: Partial<WaitlistEntry>): WaitlistEntry => ({
  id: 'w1',
  date: '2026-11-06',
  serviceId: 's1',
  serviceName: 'Strzyżenie',
  staffId: null,
  staffName: null,
  name: 'Anna Nowak',
  email: 'anna@example.com',
  phone: '+48600100200',
  status: 'waiting',
  createdAt: '2026-11-05T08:12:00.000Z',
  notifiedAt: null,
  ...over,
});

const W = {
  waiting: 'Czeka',
  notified: 'Powiadomiony(-a) {time}',
  askedAt: 'Zapisał(a) się {time}',
};

describe('waiting list of a day', () => {
  it('only the chosen day, who asked first on top, without left or removed clients', () => {
    const list: SalonWaitlist = {
      from: '2026-11-05',
      items: [
        entry({ id: 'late', createdAt: '2026-11-05T10:00:00.000Z' }),
        entry({ id: 'other-day', date: '2026-11-07' }),
        entry({ id: 'early', createdAt: '2026-11-04T18:00:00.000Z', status: 'notified' }),
        entry({ id: 'gone', status: 'cancelled' }),
      ],
    };
    expect(waitlistOfDay(list, '2026-11-06').map((e) => e.id)).toEqual(['early', 'late']);
    expect(waitlistOfDay(list, '2026-11-08')).toEqual([]);
  });

  it('says when the client joined and was told, in the salon time zone', () => {
    expect(waitlistStatus(entry({}), 'Europe/Warsaw', W)).toBe('Czeka · Zapisał(a) się 09:12');
    expect(
      waitlistStatus(
        entry({ status: 'notified', notifiedAt: '2026-11-05T13:05:00.000Z' }),
        'Europe/Warsaw',
        W,
      ),
    ).toBe('Powiadomiony(-a) 14:05 · Zapisał(a) się 09:12');
  });
});

describe('"+ Nowa wizyta" for a waiting client', () => {
  const services = [{ id: 's1' }, { id: 's2' }] as ServiceList;
  const staff = (...ids: string[]) => ids.map((id) => ({ id })) as StaffList;

  it('fills in the service, specialist, day and contacts (no phone → typed by the salon)', () => {
    expect(presetFromEntry(entry({ staffId: 'p2', phone: null }))).toEqual({
      serviceId: 's1',
      staffId: 'p2',
      date: '2026-11-06',
      client: { name: 'Anna Nowak', phone: '', email: 'anna@example.com' },
    });
  });

  it('keeps the asked-for specialist, else the only one; nothing if the service is gone', () => {
    expect(
      presetChoice({ serviceId: 's1', staffId: 'p2' }, services, () => staff('p1', 'p2')),
    ).toEqual({ serviceId: 's1', staffId: 'p2' });
    // "Any specialist", or one who no longer does the service: the salon picks.
    expect(
      presetChoice({ serviceId: 's1', staffId: null }, services, () => staff('p1', 'p2')),
    ).toEqual({ serviceId: 's1', staffId: '' });
    expect(presetChoice({ serviceId: 's1', staffId: 'p9' }, services, () => staff('p1'))).toEqual({
      serviceId: 's1',
      staffId: 'p1',
    });
    expect(presetChoice({ serviceId: 'gone', staffId: 'p1' }, services, () => staff('p1'))).toEqual(
      {
        serviceId: '',
        staffId: '',
      },
    );
  });
});

describe('BusinessApi waiting list', () => {
  it('reads the list from a day on and removes a client', async () => {
    const calls: { key: string; auth?: string }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ key, auth: headers.authorization });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a9', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : { from: '2026-11-06', items: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.waitlist('o1', 'l1', '2026-11-06');
    await api.removeFromWaitlist('o1', 'l1', 'w1');
    expect(calls.slice(1).map((c) => [c.key, c.auth])).toEqual([
      ['GET /v1/organizations/o1/locations/l1/waitlist?from=2026-11-06', 'Bearer a9'],
      ['POST /v1/organizations/o1/locations/l1/waitlist/w1/remove', 'Bearer a9'],
    ]);
  });
});
