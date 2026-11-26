import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessApi, type Me } from '../src/api';

const origin = 'https://api.test';
const refreshUrl = origin + '/v1/auth/refresh';
const meUrl = origin + '/v1/me';
const locationsUrl = origin + '/v1/organizations/org/locations';
const me: Me = {
  user: { id: 'u1', name: 'Anna', email: 'anna@example.com', locale: 'pl', emailVerified: true },
  organizations: [],
  isPlatformAdmin: false,
};

function tokens(accessToken: string, refreshToken: string) {
  return { accessToken, refreshToken, expiresIn: 900, user: me.user };
}

const renewed = tokens('new-access', 'new-refresh');
const otherAccount = {
  ...tokens('other-access', 'other-refresh'),
  user: { ...me.user, id: 'u2', email: 'other@example.com' },
};
const expired = () => Response.json({ error: { message: 'Expired' } }, { status: 401 });

const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let saved: string | null;
let api: BusinessApi;

beforeEach(() => {
  fetchFn.mockReset();
  saved = 'saved-refresh';
  api = new BusinessApi(
    origin,
    {
      get: async () => saved,
      set: async (value) => {
        saved = value;
      },
    },
    fetchFn,
  );
});

async function signIn() {
  fetchFn.mockResolvedValueOnce(Response.json(tokens('old-access', 'old-refresh')));
  expect(await api.restore()).toBe(true);
  fetchFn.mockClear();
}

describe('session renewal for business API requests', () => {
  it.each([
    { name: 'JSON write', call: () => api.createOrganization({ name: 'Łódź' }) },
    { name: 'CSV download', call: () => api.clientsCsv('org', 'pl') },
    {
      name: 'photo upload',
      call: () => api.addSalonPhoto('org', 'salon', new Blob(['photo']), 'image/jpeg'),
    },
  ])('returns the second 401 without a third attempt for a $name', async ({ call }) => {
    await signIn();
    fetchFn
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(Response.json(renewed))
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'DENIED', message: 'Still denied' } }, { status: 401 }),
      );

    await expect(call()).rejects.toMatchObject({
      status: 401,
      code: 'DENIED',
      message: 'Still denied',
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const [initial, refresh, retry] = fetchFn.mock.calls;
    expect(refresh![0]).toBe(refreshUrl);
    expect(JSON.parse(String(refresh![1]?.body))).toEqual({ refreshToken: 'old-refresh' });
    expect(new Headers(initial![1]?.headers).get('authorization')).toBe('Bearer old-access');
    expect(retry![0]).toBe(initial![0]);
    expect(retry![1]?.method).toBe(initial![1]?.method);
    expect(retry![1]?.body).toBe(initial![1]?.body);
    expect(new Headers(retry![1]?.headers).get('authorization')).toBe('Bearer new-access');
    expect(saved).toBe('new-refresh');
  });

  it.each([
    { timing: 'together', nextAccess: 'new-access' },
    { timing: 'after the first retry', nextAccess: 'new-access' },
    { timing: 'after the first retry', nextAccess: 'old-access' },
  ])(
    'renews once for two 401s arriving $timing when the new access value is $nextAccess',
    async ({ timing, nextAccess }) => {
      await signIn();
      const expiredLocations = Promise.withResolvers<Response>();

      const firstReads = new Set([meUrl, locationsUrl]);
      fetchFn.mockImplementation(async (url, init) => {
        if (url === refreshUrl) return Response.json(tokens(nextAccess, 'new-refresh'));
        const auth = new Headers(init?.headers).get('authorization');
        if (firstReads.delete(url)) {
          expect(auth).toBe('Bearer old-access');
          return url === meUrl ? expired() : expiredLocations.promise;
        }
        expect(auth).toBe(`Bearer ${nextAccess}`);
        if (url === meUrl) return Response.json(me);
        if (url === locationsUrl) return Response.json([]);
        throw new Error('Unexpected protected request');
      });

      const readMe = api.me();
      const readLocations = api.locations('org');
      if (timing === 'after the first retry') await readMe;
      expiredLocations.resolve(expired());

      await expect(Promise.all([readMe, readLocations])).resolves.toEqual([me, []]);
      const urls = fetchFn.mock.calls.map(([url]) => url);
      expect(urls.filter((url) => url === refreshUrl)).toHaveLength(1);
      expect(urls.filter((url) => url === meUrl)).toHaveLength(2);
      expect(urls.filter((url) => url === locationsUrl)).toHaveLength(2);
      expect(saved).toBe('new-refresh');
      expect(api.signedIn).toBe(true);
    },
  );

  it('discards a late 401 from a read started before another account signed in', async () => {
    await signIn();
    const readStarted = Promise.withResolvers<void>();
    const oldResponse = Promise.withResolvers<Response>();
    fetchFn
      .mockImplementationOnce(() => {
        readStarted.resolve();
        return oldResponse.promise;
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(otherAccount));

    const oldRead = api.me();
    await readStarted.promise;
    await api.signOut();
    await api.verifyCode({ email: 'other@example.com' }, '123456', 'pl');
    oldResponse.resolve(expired());

    await expect(oldRead).rejects.toThrow();
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      meUrl,
      origin + '/v1/auth/logout',
      origin + '/v1/auth/code/verify',
    ]);
    expect(api.signedIn).toBe(true);
    expect(saved).toBe('other-refresh');
  });

  it.each([
    { action: 'switching accounts', status: 200 },
    { action: 'switching accounts', status: 401 },
    { action: 'signing out', status: 200 },
  ])(
    'discards a pending refresh that returns $status after $action',
    async ({ action, status }) => {
      await signIn();
      const started = Promise.withResolvers<void>();
      const oldRefresh = Promise.withResolvers<Response>();
      fetchFn.mockImplementationOnce(() => {
        started.resolve();
        return oldRefresh.promise;
      });
      const restore = api.restore();
      await started.promise;

      if (action === 'switching accounts') {
        fetchFn.mockResolvedValueOnce(Response.json(otherAccount));
        await api.verifyCode({ email: 'other@example.com' }, '123456', 'pl');
      } else {
        fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
        await api.signOut();
      }
      oldRefresh.resolve(status === 401 ? expired() : Response.json(renewed));

      await expect(restore).resolves.toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      if (action === 'switching accounts') {
        expect(saved).toBe('other-refresh');
        fetchFn.mockResolvedValueOnce(Response.json({ ...me, user: otherAccount.user }));
        await api.me();
        expect(new Headers(fetchFn.mock.lastCall?.[1]?.headers).get('authorization')).toBe(
          'Bearer other-access',
        );
      } else {
        expect(saved).toBeNull();
        expect(api.signedIn).toBe(false);
      }
    },
  );

  it.each([
    { data: null },
    { data: {} },
    { data: { accessToken: '', refreshToken: 'replacement' } },
    { data: { accessToken: 7, refreshToken: 'replacement' } },
    { data: { ...renewed, refreshToken: '   ' } },
    { data: { ...renewed, refreshToken: 7 } },
  ])('keeps the saved session when refresh returns malformed tokens ($data)', async ({ data }) => {
    fetchFn.mockResolvedValueOnce(Response.json(data));
    await expect(api.restore()).rejects.toMatchObject({ name: 'ApiError', status: 200 });
    expect(api.signedIn).toBe(false);
    expect(saved).toBe('saved-refresh');

    fetchFn.mockResolvedValueOnce(Response.json(renewed));
    await expect(api.restore()).resolves.toBe(true);
    expect(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))).toEqual({
      refreshToken: 'saved-refresh',
    });
    expect(saved).toBe('new-refresh');
  });

  it('keeps the session and stops the request when the transport times out during refresh', async () => {
    await signIn();
    const timeout = new DOMException('Connection timed out', 'TimeoutError');
    fetchFn.mockResolvedValueOnce(expired()).mockRejectedValueOnce(timeout);
    await expect(api.me()).rejects.toBe(timeout);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([meUrl, refreshUrl]);
    expect(saved).toBe('old-refresh');
    expect(api.signedIn).toBe(true);
  });

  it('honours the caller-provided deadline for an in-flight read without renewing the session', async () => {
    await signIn();
    vi.useFakeTimers({ now: new Date('2026-11-26T14:50:00Z') });
    try {
      const controller = new AbortController();
      const timeout = new DOMException('Read deadline reached', 'TimeoutError');
      const started = Promise.withResolvers<void>();
      fetchFn.mockImplementationOnce((_url, init) => {
        started.resolve();
        const signal = init?.signal;
        if (!signal) throw new Error('Missing request signal');
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const read = api.reviewSettings('org', 'salon', controller.signal);
      const settled = vi.fn();
      void read.then(settled, settled);
      await started.promise;
      setTimeout(() => controller.abort(timeout), 1000);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(read).rejects.toBe(timeout);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(api.signedIn).toBe(true);
      expect(saved).toBe('old-refresh');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a read while another read waits for the same refresh', async () => {
    await signIn();
    const controller = new AbortController();
    const refreshStarted = Promise.withResolvers<void>();
    const refreshReply = Promise.withResolvers<Response>();
    fetchFn.mockImplementation(async (url, init) => {
      if (url === refreshUrl) {
        refreshStarted.resolve();
        return refreshReply.promise;
      }
      if (new Headers(init?.headers).get('authorization') === 'Bearer old-access') return expired();
      if (url === meUrl) return Response.json(me);
      throw new Error('Unexpected retry of the cancelled read');
    });

    const cancelledRead = api.guardSettings('org', 'salon', controller.signal);
    const activeRead = api.me();
    await refreshStarted.promise;
    controller.abort();
    await expect(cancelledRead).rejects.toBe(controller.signal.reason);
    refreshReply.resolve(Response.json(renewed));
    await expect(activeRead).resolves.toEqual(me);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(saved).toBe('new-refresh');
  });
});
