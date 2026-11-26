import { describe, expect, it, vi } from 'vitest';
import { ClientApi, type TokenStore } from '../src/api';

function savedSession(): TokenStore {
  let token: string | null = 'test-session';
  return {
    get: async () => token,
    set: async (next) => {
      token = next;
    },
  };
}

const person = { id: 'test-client', email: 'client@example.test', locale: 'uk' };

describe('reopening the client after losing the connection', () => {
  it('restores the same session when the service recovers', async () => {
    const store = savedSession();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(person));
    const api = new ClientApi('https://api.test', store, fetchFn);
    await expect(api.restore()).rejects.toMatchObject({ status: 503 });

    const reopened = new ClientApi('https://api.test', store, fetchFn);
    await expect(reopened.restore()).resolves.toEqual(person);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchFn.mock.calls) {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-session');
    }
  });

  it('keeps the client signed out on this device after an offline logout', async () => {
    const store = savedSession();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(Response.json(person))
      .mockRejectedValueOnce(new TypeError('Network request failed'));
    const api = new ClientApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.signOut();
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.test/v1/client/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(api.signedIn).toBe(false);

    const reopened = new ClientApi('https://api.test', store, fetchFn);
    await expect(reopened.restore()).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
