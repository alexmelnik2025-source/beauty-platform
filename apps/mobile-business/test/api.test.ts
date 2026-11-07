import { describe, expect, it } from 'vitest';
import { BusinessApi, parseContact, type TokenStore } from '../src/api';

/** A fake API: answers by "METHOD path", remembers every request. */
function fakeServer(routes: Record<string, (body: unknown, auth?: string) => [number, unknown?]>) {
  const calls: { key: string; body: unknown; auth?: string }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const key = `${init?.method} ${url.replace('https://api.test', '')}`;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body, auth: headers.authorization });
    const route = routes[key];
    const [status, data] = route ? route(body, headers.authorization) : [404, { error: {} }];
    return new Response(status === 204 ? null : JSON.stringify(data ?? {}), { status });
  };
  return { fetchFn, calls };
}

function memoryStore(initial: string | null = null): TokenStore & { value: string | null } {
  return {
    value: initial,
    async get() {
      return this.value;
    },
    async set(v) {
      this.value = v;
    },
  };
}

const tokens = (access: string, refresh: string) => ({
  accessToken: access,
  expiresIn: 900,
  refreshToken: refresh,
  user: { id: 'u1', email: 'kasia@example.com', name: 'Kasia', locale: 'pl', emailVerified: true },
});

describe('parseContact', () => {
  it('reads emails and phone numbers; 9 digits are a Polish number', () => {
    expect(parseContact(' Kasia@Example.com ')).toEqual({ email: 'kasia@example.com' });
    expect(parseContact('600 100 200')).toEqual({ phone: '+48600100200' });
    expect(parseContact('+380 (67) 123-45-67')).toEqual({ phone: '+380671234567' });
    expect(parseContact('0048600100200')).toEqual({ phone: '+48600100200' });
    expect(parseContact('kasia@')).toBeNull();
    expect(parseContact('12345')).toBeNull();
    expect(parseContact('')).toBeNull();
  });
});

describe('BusinessApi', () => {
  it('signs in with a code as a mobile client and keeps the refresh token', async () => {
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/code': () => [
        202,
        { codeExpiresAt: '2026-11-03T10:00:00Z', channel: 'email' },
      ],
      'POST /v1/auth/code/verify': () => [200, tokens('a1', 'r1-refresh-token-0123456789')],
      'GET /v1/me': (_b, auth) =>
        auth === 'Bearer a1' ? [200, { user: {}, organizations: [] }] : [401],
    });
    const store = memoryStore();
    const api = new BusinessApi('https://api.test', store, fetchFn, 'Test phone');

    const sent = await api.requestCode({ phone: '+48600100200' }, 'uk');
    expect(sent.channel).toBe('email');
    expect(calls[0]).toMatchObject({ body: { phone: '+48600100200', locale: 'uk' } });

    await api.verifyCode({ phone: '+48600100200' }, '123456', 'uk');
    expect(calls[1]?.body).toEqual({
      phone: '+48600100200',
      code: '123456',
      locale: 'uk',
      clientType: 'mobile',
      deviceName: 'Test phone',
    });
    expect(store.value).toBe('r1-refresh-token-0123456789');
    expect(api.signedIn).toBe(true);
    await expect(api.me()).resolves.toMatchObject({ organizations: [] });
  });

  it('renews an expired access token once and repeats the call', async () => {
    let issued = 0;
    let valid = '';
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/refresh': () => {
        issued += 1;
        valid = `access-${issued}`;
        return [200, tokens(valid, `refresh-${issued}-0123456789abcdefghij`)];
      },
      'GET /v1/organizations/o1/locations/l1/calendar?from=2026-11-03&to=2026-11-03': (_b, auth) =>
        auth === `Bearer ${valid}` ? [200, { appointments: [] }] : [401],
    });
    const store = memoryStore('saved-refresh-token-0123456789');
    const api = new BusinessApi('https://api.test', store, fetchFn);

    // App start: the saved token signs in again.
    expect(await api.restore()).toBe(true);
    expect(calls[0]?.body).toEqual({ refreshToken: 'saved-refresh-token-0123456789' });
    // The access token expires on the server: one more refresh, then the same call again.
    valid = 'something-else';
    await expect(api.calendar('o1', 'l1', '2026-11-03')).resolves.toEqual({ appointments: [] });
    expect(calls.map((c) => c.key)).toEqual([
      'POST /v1/auth/refresh',
      'GET /v1/organizations/o1/locations/l1/calendar?from=2026-11-03&to=2026-11-03',
      'POST /v1/auth/refresh',
      'GET /v1/organizations/o1/locations/l1/calendar?from=2026-11-03&to=2026-11-03',
    ]);
    // The refresh token rotates every time; the newest one is kept.
    expect(calls[2]?.body).toEqual({ refreshToken: 'refresh-1-0123456789abcdefghij' });
    expect(store.value).toBe('refresh-2-0123456789abcdefghij');
  });

  it('a rejected refresh token signs out on this phone', async () => {
    const { fetchFn } = fakeServer({
      'POST /v1/auth/refresh': () => [401, { error: { code: 'UNAUTHORIZED', message: 'expired' } }],
    });
    const store = memoryStore('revoked-refresh-token-0123456789');
    const api = new BusinessApi('https://api.test', store, fetchFn);
    expect(await api.restore()).toBe(false);
    expect(store.value).toBeNull();
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
  });

  it('nothing saved → the sign-in screen, without asking the server', async () => {
    const { fetchFn, calls } = fakeServer({});
    const api = new BusinessApi('https://api.test', memoryStore(), fetchFn);
    expect(await api.restore()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('passes on the API error code and message', async () => {
    const { fetchFn } = fakeServer({
      'POST /v1/auth/code/verify': () => [
        400,
        { error: { code: 'INVALID_CODE', message: 'Wrong code', requestId: 'r' } },
      ],
    });
    const api = new BusinessApi('https://api.test', memoryStore(), fetchFn);
    await expect(api.verifyCode({ email: 'a@b.pl' }, '000000', 'pl')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_CODE',
      message: 'Wrong code',
    });
  });

  it('signs out on the server and forgets the token', async () => {
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/refresh': () => [200, tokens('a2', 'refresh-token-0123456789abc')],
      'POST /v1/auth/logout': (_b, auth) => (auth === 'Bearer a2' ? [204] : [401]),
    });
    const store = memoryStore('refresh-token-0123456789abc');
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.signOut();
    expect(calls.at(-1)?.key).toBe('POST /v1/auth/logout');
    expect(store.value).toBeNull();
    expect(api.signedIn).toBe(false);
  });

  it('reads a visit and marks it "came" and "paid" with the version it read', async () => {
    const base = '/v1/organizations/o1/locations/l1/appointments/a1';
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/refresh': () => [200, tokens('a3', 'refresh-token-0123456789xyz')],
      [`GET ${base}`]: () => [200, { id: 'a1', version: 4, status: 'confirmed' }],
      [`POST ${base}/status`]: () => [200, { id: 'a1', version: 5, status: 'completed' }],
      [`POST ${base}/payment`]: () => [200, { id: 'a1', version: 6, paidAt: 'now' }],
      'GET /v1/organizations/o1/permissions': () => [200, { me: { role: 'staff' } }],
      'GET /v1/organizations/o1/locations/l1/staff': () => [200, []],
    });
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('refresh-token-0123456789abc'),
      fetchFn,
    );
    await api.restore();
    expect(await api.appointment('o1', 'l1', 'a1')).toMatchObject({ version: 4 });
    await api.setStatus('o1', 'l1', 'a1', 4, 'completed');
    await api.setPaid('o1', 'l1', 'a1', 5, true);
    await api.permissions('o1');
    await api.staff('o1', 'l1');
    expect(calls.slice(1).map((c) => [c.key, c.body, c.auth])).toEqual([
      [`GET ${base}`, undefined, 'Bearer a3'],
      [`POST ${base}/status`, { version: 4, status: 'completed' }, 'Bearer a3'],
      [`POST ${base}/payment`, { version: 5, paid: true }, 'Bearer a3'],
      ['GET /v1/organizations/o1/permissions', undefined, 'Bearer a3'],
      ['GET /v1/organizations/o1/locations/l1/staff', undefined, 'Bearer a3'],
    ]);
  });

  it("reads a specialist's schedule and adds / removes time off", async () => {
    const base = '/v1/organizations/o1/locations/l1/staff/s1';
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/refresh': () => [200, tokens('a4', 'refresh-token-0123456789qrs')],
      [`GET ${base}/working-hours`]: () => [200, { weekly: [], overrides: [] }],
      [`GET ${base}/time-off`]: () => [200, []],
      [`POST ${base}/time-off`]: () => [201, { id: 't1' }],
      [`DELETE ${base}/time-off/t1`]: () => [204],
    });
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('refresh-token-0123456789abc'),
      fetchFn,
    );
    await api.restore();
    await api.workingHours('o1', 'l1', 's1');
    await api.timeOff('o1', 'l1', 's1');
    await api.addTimeOff('o1', 'l1', 's1', {
      start: '2026-12-24T00:00',
      end: '2026-12-27T00:00',
      note: 'Urlop',
    });
    await expect(api.removeTimeOff('o1', 'l1', 's1', 't1')).resolves.toBeUndefined();
    expect(calls.slice(1).map((c) => [c.key, c.body])).toEqual([
      [`GET ${base}/working-hours`, undefined],
      [`GET ${base}/time-off`, undefined],
      [
        `POST ${base}/time-off`,
        { start: '2026-12-24T00:00', end: '2026-12-27T00:00', note: 'Urlop' },
      ],
      [`DELETE ${base}/time-off/t1`, undefined],
    ]);
  });
  it('books a client: services, free times, client search and the new visit', async () => {
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/refresh': () => [200, tokens('a1', 'r2-refresh-token-0123456789')],
      'GET /v1/organizations/o1/locations/l1/services': () => [200, []],
      'GET /v1/organizations/o1/locations/l1/availability?serviceId=v1&staffId=s1&from=2026-11-05&to=2026-11-05':
        () => [200, { timezone: 'Europe/Warsaw', serviceId: 'v1', durationMinutes: 30, slots: [] }],
      'GET /v1/organizations/o1/customers?limit=20&search=Jan+N': () => [200, []],
      'POST /v1/organizations/o1/locations/l1/appointments': () => [201, { id: 'a9' }],
    });
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('saved-refresh-token-0123456789'),
      fetchFn,
    );
    await api.services('o1', 'l1');
    await api.availability('o1', 'l1', { serviceId: 'v1', staffId: 's1', date: '2026-11-05' });
    await api.customers('o1', 'Jan N', 20);
    const body = {
      serviceId: 'v1',
      staffId: 's1',
      start: '2026-11-05T08:00:00Z',
      customer: { name: 'Jan', phone: '+48600100200', locale: 'pl' as const },
    };
    await expect(api.createAppointment('o1', 'l1', body)).resolves.toEqual({ id: 'a9' });
    expect(calls.at(-1)).toMatchObject({ body, auth: 'Bearer a1' });
  });
  it('moves and cancels a visit with the version it read', async () => {
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/refresh': () => [200, tokens('a1', 'r2-refresh-token-0123456789')],
      'POST /v1/organizations/o1/locations/l1/appointments/a9/reschedule': () => [
        200,
        { id: 'a9' },
      ],
      'POST /v1/organizations/o1/locations/l1/appointments/a9/cancel': () => [200, { id: 'a9' }],
    });
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('saved-refresh-token-0123456789'),
      fetchFn,
    );
    await api.reschedule('o1', 'l1', 'a9', 3, '2026-11-05T09:00:00Z');
    await api.cancel('o1', 'l1', 'a9', 4, 'Mistrz chory');
    expect(calls.slice(-2).map((c) => c.body)).toEqual([
      { version: 3, start: '2026-11-05T09:00:00Z' },
      { version: 4, reason: 'Mistrz chory' },
    ]);
  });
  it('reads the salon report for a period; a refused report passes on 403', async () => {
    const path = '/v1/organizations/o1/locations/l1/reports?from=2026-11-01&to=2026-11-04';
    let allowed = true;
    const { fetchFn, calls } = fakeServer({
      'POST /v1/auth/refresh': () => [200, tokens('a5', 'refresh-token-0123456789tuv')],
      [`GET ${path}`]: () =>
        allowed ? [200, { scope: 'location' }] : [403, { error: { code: 'FORBIDDEN' } }],
    });
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('refresh-token-0123456789abc'),
      fetchFn,
    );
    await api.restore();
    await expect(api.report('o1', 'l1', '2026-11-01', '2026-11-04')).resolves.toEqual({
      scope: 'location',
    });
    allowed = false;
    await expect(api.report('o1', 'l1', '2026-11-01', '2026-11-04')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(calls.slice(1).map((c) => [c.key, c.auth])).toEqual([
      [`GET ${path}`, 'Bearer a5'],
      [`GET ${path}`, 'Bearer a5'],
    ]);
  });
});

describe('"Zamknij kasę" (task 232)', () => {
  it('reads the till of a day and saves the counted cash', async () => {
    const path = '/v1/organizations/o1/locations/l1/reports/till-close';
    const sent: unknown[] = [];
    const { fetchFn } = fakeServer({
      'POST /v1/auth/refresh': () => [200, tokens('a6', 'refresh-token-0123456789xyz')],
      [`GET ${path}?date=2026-11-06`]: () => [200, { date: '2026-11-06', close: null }],
      [`PUT ${path}`]: (body) => {
        sent.push(body);
        return [200, { date: '2026-11-06', close: { differenceGrosze: -1000 } }];
      },
    });
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('refresh-token-0123456789abc'),
      fetchFn,
    );
    await api.restore();
    await expect(api.tillClose('o1', 'l1', '2026-11-06')).resolves.toMatchObject({ close: null });
    await expect(api.closeTill('o1', 'l1', '2026-11-06', 8000, 'Reszta')).resolves.toMatchObject({
      close: { differenceGrosze: -1000 },
    });
    expect(sent).toEqual([{ date: '2026-11-06', countedCashGrosze: 8000, note: 'Reszta' }]);
  });
});

describe('visit photos (task 80b)', () => {
  it('turns the signed picture links into full addresses for the phone', () => {
    const api = new BusinessApi('https://api.test/', memoryStore(), fakeServer({}).fetchFn);
    expect(api.absoluteUrl('/v1/public/visit-photos/p1?exp=1&sig=ab')).toBe(
      'https://api.test/v1/public/visit-photos/p1?exp=1&sig=ab',
    );
    expect(api.absoluteUrl('https://cdn.test/x.jpg')).toBe('https://cdn.test/x.jpg');
  });

  it('downloads the report CSV with the access token and the server’s file name (task 220)', async () => {
    const seen: { url: string; auth?: string; accept?: string }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: headers.authorization, accept: headers.accept });
      if (url.endsWith('/v1/auth/refresh')) {
        return new Response(JSON.stringify(tokens('a2', 'r2-refresh-token-0123456789')), {
          status: 200,
        });
      }
      if (headers.authorization !== 'Bearer a2') return new Response('{}', { status: 401 });
      return new Response('\uFEFFData;Godzina\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="visits-2026-11-01-2026-11-30.csv"',
        },
      });
    };
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('r1-refresh-token-0123456789'),
      fetchFn,
    );
    const file = await api.visitsCsv('o1', 'l1', '2026-11-01', '2026-11-30', 'pl');
    expect(file).toEqual({
      fileName: 'visits-2026-11-01-2026-11-30.csv',
      csv: '\uFEFFData;Godzina\n',
    });
    const csvCall = seen.find((c) => c.url.includes('visits-csv'))!;
    expect(csvCall.url).toBe(
      'https://api.test/v1/organizations/o1/locations/l1/reports/visits-csv?from=2026-11-01&to=2026-11-30&locale=pl',
    );
    expect(csvCall).toMatchObject({ auth: 'Bearer a2', accept: 'text/csv' });
  });
});
