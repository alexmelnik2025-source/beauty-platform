import { describe, expect, it } from 'vitest';
import { ClientApi, parseEmail, type TokenStore } from '../src/api';

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
