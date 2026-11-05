import { describe, expect, it } from 'vitest';
import {
  addDays,
  ApiError,
  bookingUrl,
  ClientApi,
  type ClientAppointment,
  myDataFileName,
  newRequestKey,
  PAGE_SIZE,
  parseEmail,
  todayIn,
  type TokenStore,
} from '../src/api';

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

const person = { id: 'p1', email: 'anna@example.com', locale: 'uk' };

describe('parseEmail', () => {
  it('cleans up an email and rejects anything else', () => {
    expect(parseEmail(' Anna@Example.com ')).toBe('anna@example.com');
    expect(parseEmail('anna@')).toBeNull();
    expect(parseEmail('600100200')).toBeNull();
    expect(parseEmail('')).toBeNull();
  });
});

describe('ClientApi', () => {
  it('signs in with an emailed code as a mobile client and keeps the session token', async () => {
    const { fetchFn, calls } = fakeServer({
      'POST /v1/client/auth/code': () => [202, { codeExpiresAt: '2026-11-04T10:00:00Z' }],
      'POST /v1/client/auth/verify': () => [
        200,
        { person, expiresAt: '2027-02-02T10:00:00Z', token: 'session-token-0123456789' },
      ],
      'GET /v1/client/appointments?scope=upcoming': (_b, auth) =>
        auth === 'Bearer session-token-0123456789' ? [200, { items: [] }] : [401],
    });
    const store = memoryStore();
    const api = new ClientApi('https://api.test', store, fetchFn);

    await api.requestCode('anna@example.com', 'uk');
    expect(calls[0]?.body).toEqual({ email: 'anna@example.com', locale: 'uk' });
    await expect(api.verifyCode('anna@example.com', '123456', 'uk')).resolves.toEqual(person);
    expect(calls[1]?.body).toEqual({
      email: 'anna@example.com',
      code: '123456',
      locale: 'uk',
      clientType: 'mobile',
    });
    expect(store.value).toBe('session-token-0123456789');
    expect(api.signedIn).toBe(true);
    await expect(api.appointments('upcoming')).resolves.toEqual({ items: [] });
  });

  it('opens again with the saved session; history is asked with scope=past', async () => {
    const { fetchFn, calls } = fakeServer({
      'GET /v1/client/me': (_b, auth) => (auth === 'Bearer saved-token' ? [200, person] : [401]),
      'GET /v1/client/appointments?scope=past': () => [200, { items: [{ id: 'a1' }] }],
      'PATCH /v1/client/me': (body) => [200, { ...person, ...(body as object) }],
    });
    const api = new ClientApi('https://api.test', memoryStore('saved-token'), fetchFn);
    await expect(api.restore()).resolves.toEqual(person);
    await expect(api.appointments('past')).resolves.toEqual({ items: [{ id: 'a1' }] });
    await expect(api.setLocale('ru')).resolves.toMatchObject({ locale: 'ru' });
    expect(calls.map((c) => [c.key, c.body, c.auth])).toEqual([
      ['GET /v1/client/me', undefined, 'Bearer saved-token'],
      ['GET /v1/client/appointments?scope=past', undefined, 'Bearer saved-token'],
      ['PATCH /v1/client/me', { locale: 'ru' }, 'Bearer saved-token'],
    ]);
  });

  it('nothing saved → the sign-in screen, without asking the server', async () => {
    const { fetchFn, calls } = fakeServer({});
    const api = new ClientApi('https://api.test', memoryStore(), fetchFn);
    await expect(api.restore()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    await expect(api.appointments('upcoming')).rejects.toMatchObject({ status: 401 });
  });

  it('a session the server no longer accepts is forgotten on this phone', async () => {
    const { fetchFn } = fakeServer({
      'GET /v1/client/me': () => [401, { error: { code: 'UNAUTHORIZED', message: 'ended' } }],
    });
    const store = memoryStore('ended-token');
    const api = new ClientApi('https://api.test', store, fetchFn);
    await expect(api.restore()).resolves.toBeNull();
    expect(store.value).toBeNull();
    expect(api.signedIn).toBe(false);
  });

  it('a server that cannot be reached is not mistaken for a signed-out client', async () => {
    const api = new ClientApi('https://api.test', memoryStore('saved-token'), async () => {
      throw new TypeError('Network request failed');
    });
    await expect(api.restore()).rejects.toThrow('Network request failed');
    expect(api.signedIn).toBe(true);
  });

  it('passes on the API error code', async () => {
    const { fetchFn } = fakeServer({
      'POST /v1/client/auth/verify': () => [
        400,
        { error: { code: 'INVALID_CODE', message: 'Wrong code', requestId: 'r' } },
      ],
    });
    const api = new ClientApi('https://api.test', memoryStore(), fetchFn);
    await expect(api.verifyCode('a@b.pl', '000000', 'pl')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_CODE',
    });
  });

  it('signs out on the server and forgets the token', async () => {
    const { fetchFn, calls } = fakeServer({
      'GET /v1/client/me': () => [200, person],
      'POST /v1/client/auth/logout': (_b, auth) => (auth === 'Bearer t1' ? [204] : [401]),
    });
    const store = memoryStore('t1');
    const api = new ClientApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.signOut();
    expect(calls.at(-1)?.key).toBe('POST /v1/client/auth/logout');
    expect(store.value).toBeNull();
    expect(api.signedIn).toBe(false);
  });
});

describe('catalogue (no sign-in)', () => {
  const directory = { items: [], page: 1, pageSize: PAGE_SIZE, total: 0, pageCount: 0 };

  it('asks for a page, with the language when one is chosen, without a token', async () => {
    const { fetchFn, calls } = fakeServer({
      [`GET /v1/public/locations?page=1&pageSize=${PAGE_SIZE}`]: () => [200, directory],
      [`GET /v1/public/locations?page=2&pageSize=${PAGE_SIZE}&language=uk`]: () => [
        200,
        { ...directory, page: 2 },
      ],
    });
    const api = new ClientApi('https://api.test', memoryStore('session'), fetchFn);
    expect(await api.directory()).toEqual(directory);
    expect((await api.directory({ page: 2, language: 'uk' })).page).toBe(2);
    expect(calls.map((c) => c.auth)).toEqual([undefined, undefined]);
  });

  it('opens a salon by its link name; a missing one is a 404', async () => {
    const { fetchFn } = fakeServer({
      'GET /v1/public/locations/gestalt%20bema': () => [200, { slug: 'gestalt bema' }],
    });
    const api = new ClientApi('https://api.test', memoryStore(), fetchFn);
    expect((await api.salon('gestalt bema')).slug).toBe('gestalt bema');
    const missing = await api.salon('nope').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(404);
  });

  it('links to the web booking page in the app language', () => {
    expect(bookingUrl('http://localhost:3000/', 'uk', 'gestalt-bema')).toBe(
      'http://localhost:3000/uk/b/gestalt-bema',
    );
  });
});

describe('one visit', () => {
  /** Remembers the headers too: cancelling must carry an Idempotency-Key. */
  function recordingFetch(answer: (method: string, path: string) => [number, unknown?]) {
    const calls: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string;
    }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = url.replace('https://api.test', '');
      calls.push({
        method,
        path,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? String(init.body) : undefined,
      });
      const [status, data] = answer(method, path);
      return new Response(JSON.stringify(data ?? {}), { status });
    };
    return { fetchFn, calls };
  }

  it('reads a visit and cancels it once per key, signed in', async () => {
    const { fetchFn, calls } = recordingFetch((method, path) =>
      path === '/v1/client/appointments/a1' && method === 'GET'
        ? [200, { id: 'a1', status: 'confirmed' }]
        : path === '/v1/client/appointments/a1/cancel' && method === 'POST'
          ? [200, { id: 'a1', status: 'cancelled' }]
          : [404],
    );
    const api = new ClientApi('https://api.test', memoryStore('session-token'), fetchFn);
    await api.restore().catch(() => null);
    calls.length = 0;
    expect((await api.appointment('a1')).status).toBe('confirmed');
    expect((await api.cancel('a1', 'key-12345678')).status).toBe('cancelled');
    const cancel = calls.at(-1)!;
    expect(cancel.headers.authorization).toBe('Bearer session-token');
    expect(cancel.headers['idempotency-key']).toBe('key-12345678');
    expect(cancel.body).toBe('{}');
  });

  it('lists my coupons for a visit, uses one and takes it off (task 10d)', async () => {
    const { fetchFn, calls } = recordingFetch((method, path) =>
      path === '/v1/client/appointments/a1/coupons' && method === 'GET'
        ? [200, { applied: [], available: [{ id: 'c1', problem: null }] }]
        : path === '/v1/client/appointments/a1/coupons' && method === 'POST'
          ? [200, { id: 'a1', discountGrosze: 2000 }]
          : path === '/v1/client/appointments/a1/coupons/c1/remove' && method === 'POST'
            ? [200, { id: 'a1', discountGrosze: 0 }]
            : [404],
    );
    const api = new ClientApi('https://api.test', memoryStore('session-token'), fetchFn);
    await api.restore().catch(() => null);
    calls.length = 0;
    expect((await api.visitCoupons('a1')).available).toHaveLength(1);
    expect((await api.useCoupon('a1', 'c1')).discountGrosze).toBe(2000);
    expect(calls.at(-1)!.body).toBe('{"couponId":"c1"}');
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer session-token');
    expect((await api.dropCoupon('a1', 'c1')).discountGrosze).toBe(0);
  });

  it('too late to cancel comes back with the code the screen explains', async () => {
    const { fetchFn } = recordingFetch(() => [
      409,
      { error: { code: 'TOO_LATE_TO_CHANGE', message: 'Too late' } },
    ]);
    const api = new ClientApi('https://api.test', memoryStore('session-token'), fetchFn);
    await api.restore().catch(() => null);
    const error = await api.cancel('a1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TOO_LATE_TO_CHANGE');
  });

  it('request keys are new every time and fit the API rule (8–100 letters, digits, - _)', () => {
    const a = newRequestKey();
    const b = newRequestKey();
    expect(a).not.toBe(b);
    for (const key of [a, b]) expect(key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });
});

describe('change time', () => {
  const visit = {
    id: 'a1',
    service: { id: 's1' },
    staff: { id: 'k1' },
    salon: { slug: 'gestalt barber' },
  } as ClientAppointment;

  it('asks for free times of the same specialist and service, three weeks from the given day', async () => {
    const paths: string[] = [];
    const fetchFn = async (url: string) => {
      paths.push(url.replace('https://api.test', ''));
      return new Response(JSON.stringify({ slots: [] }), { status: 200 });
    };
    const api = new ClientApi('https://api.test', memoryStore(null), fetchFn);
    await api.freeTimes(visit, '2026-11-28');
    expect(paths).toEqual([
      '/v1/public/locations/gestalt%20barber/availability?serviceId=s1&staffId=k1&from=2026-11-28&to=2026-12-18',
    ]);
  });

  it('asks for the free times of a price line ("any of these", task 70c)', async () => {
    const paths: string[] = [];
    const fetchFn = async (url: string) => {
      paths.push(url.replace('https://api.test', ''));
      return new Response(JSON.stringify({ slots: [] }), { status: 200 });
    };
    const api = new ClientApi('https://api.test', memoryStore(null), fetchFn);
    await api.availability('gestalt', {
      serviceId: 's1',
      staffIds: ['k1', 'm2'],
      from: '2026-11-28',
      to: '2026-12-18',
    });
    expect(paths).toEqual([
      '/v1/public/locations/gestalt/availability?serviceId=s1&from=2026-11-28&to=2026-12-18&staffIds=k1%2Cm2',
    ]);
  });

  it('moves a visit once per key, signed in; a taken time comes back as SLOT_TAKEN', async () => {
    const calls: { path: string; headers: Record<string, string>; body?: string }[] = [];
    let taken = false;
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({
        path: url.replace('https://api.test', ''),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? String(init.body) : undefined,
      });
      if (taken) {
        return new Response(JSON.stringify({ error: { code: 'SLOT_TAKEN', message: 'Taken' } }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({ id: 'a1', time: '17:30' }), { status: 200 });
    };
    const api = new ClientApi('https://api.test', memoryStore('session-token'), fetchFn);
    await api.restore().catch(() => null);
    const moved = await api.reschedule('a1', '2026-11-10T16:30:00.000Z', 'key-12345678');
    expect(moved.time).toBe('17:30');
    const call = calls.at(-1)!;
    expect(call.path).toBe('/v1/client/appointments/a1/reschedule');
    expect(call.headers.authorization).toBe('Bearer session-token');
    expect(call.headers['idempotency-key']).toBe('key-12345678');
    expect(JSON.parse(call.body!)).toEqual({ start: '2026-11-10T16:30:00.000Z' });
    taken = true;
    const error = await api.reschedule('a1', '2026-11-10T16:30:00.000Z').catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('SLOT_TAKEN');
  });

  it('days are counted on the calendar, and "today" is the salon’s day, not the phone’s', () => {
    expect(addDays('2026-11-28', 20)).toBe('2026-12-18');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30'); // over the switch to summer time
    // 23:30 UTC on 4 Nov is already 5 Nov in Warsaw, still 4 Nov in New York.
    const late = new Date('2026-11-04T23:30:00Z');
    expect(todayIn('Europe/Warsaw', late)).toBe('2026-11-05');
    expect(todayIn('America/New_York', late)).toBe('2026-11-04');
  });
});

describe('favourite salons (task 61)', () => {
  const salon = {
    slug: 'barber-one',
    name: 'Barber One',
    addressLine: 'Prosta 1',
    city: 'Warszawa',
    postalCode: '00-001',
    bookable: true,
    addedAt: '2026-11-04T10:00:00.000Z',
  };

  it('lists, saves and removes with the session token; the link name is escaped', async () => {
    const { fetchFn, calls } = fakeServer({
      'GET /v1/client/me': () => [200, person],
      'GET /v1/client/favorites': () => [200, { items: [salon] }],
      'PUT /v1/client/favorites/barber%20one': () => [204],
      'DELETE /v1/client/favorites/barber-one': () => [204],
    });
    const api = new ClientApi('https://api.test', memoryStore('tok'), fetchFn);
    await api.restore();
    expect(api.signedIn).toBe(true);

    expect((await api.favorites()).items).toEqual([salon]);
    await expect(api.addFavorite('barber one')).resolves.toBeUndefined();
    await expect(api.removeFavorite('barber-one')).resolves.toBeUndefined();
    const favoriteCalls = calls.filter((c) => c.key.includes('/favorites'));
    expect(favoriteCalls.map((c) => c.key)).toEqual([
      'GET /v1/client/favorites',
      'PUT /v1/client/favorites/barber%20one',
      'DELETE /v1/client/favorites/barber-one',
    ]);
    expect(favoriteCalls.every((c) => c.auth === 'Bearer tok')).toBe(true);
  });

  it('a full list comes back with the code the screen explains', async () => {
    const { fetchFn } = fakeServer({
      'GET /v1/client/me': () => [200, person],
      'PUT /v1/client/favorites/barber-one': () => [
        409,
        { error: { code: 'TOO_MANY_FAVORITES', message: 'At most 100 favourite salons' } },
      ],
    });
    const api = new ClientApi('https://api.test', memoryStore('tok'), fetchFn);
    await api.restore();
    const error = await api.addFavorite('barber-one').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TOO_MANY_FAVORITES');
  });
});

describe('ClientApi: waiting list (task 51)', () => {
  it('lists, joins with the session (never an email) and leaves', async () => {
    const entry = { id: 'w1', date: '2026-11-10', status: 'waiting' };
    const { fetchFn, calls } = fakeServer({
      'GET /v1/client/me': () => [200, person],
      'GET /v1/client/waitlist': () => [200, { items: [entry] }],
      'POST /v1/client/waitlist/locations/barber%20one': () => [
        201,
        { date: '2026-11-10', status: 'waiting', alreadyWaiting: false },
      ],
      'POST /v1/client/waitlist/w1/cancel': () => [200, { ...entry, status: 'cancelled' }],
    });
    const api = new ClientApi('https://api.test', memoryStore('tok'), fetchFn);
    await api.restore();

    expect((await api.waitlist()).items).toEqual([entry]);
    const joined = await api.joinWaitlist('barber one', {
      serviceId: 's1',
      date: '2026-11-10',
      name: 'Anna',
      locale: 'pl',
    });
    expect(joined.alreadyWaiting).toBe(false);
    const join = calls.find((c) => c.key.startsWith('POST /v1/client/waitlist/locations'));
    expect(join?.body).toEqual({
      serviceId: 's1',
      date: '2026-11-10',
      name: 'Anna',
      locale: 'pl',
      acceptTerms: true,
    });
    expect((await api.leaveWaitlist('w1')).status).toBe('cancelled');
    expect(
      calls.filter((c) => c.key.includes('/waitlist')).every((c) => c.auth === 'Bearer tok'),
    ).toBe(true);
  });
});

describe('"Download my data" (task 97)', () => {
  it('asks for the export with the session token; the file is named by the export date', async () => {
    const data = { exportedAt: '2026-11-05T09:30:00.000Z', email: 'anna@example.com', salons: [] };
    const { fetchFn, calls } = fakeServer({
      'GET /v1/client/me': () => [200, person],
      'GET /v1/client/export': (_b, auth) =>
        auth === 'Bearer saved-token-0123456789' ? [200, data] : [401],
    });
    const api = new ClientApi('https://api.test', memoryStore('saved-token-0123456789'), fetchFn);
    await api.restore();
    const exported = await api.exportData();
    expect(exported).toEqual(data);
    expect(calls.at(-1)?.key).toBe('GET /v1/client/export');
    expect(myDataFileName(exported)).toBe('my-data-2026-11-05.json');
  });

  it('without a session there is no request', async () => {
    const { fetchFn, calls } = fakeServer({});
    const api = new ClientApi('https://api.test', memoryStore(), fetchFn);
    await expect(api.exportData()).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(0);
  });
});
