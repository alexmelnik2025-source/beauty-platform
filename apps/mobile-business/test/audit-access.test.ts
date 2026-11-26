import { expect, it, vi } from 'vitest';
import { BusinessApi, type TokenStore } from '../src/api';

it('keeps the saved session after an offline restart and forgets it after explicit offline sign-out', async () => {
  let saved: string | null = 'first-session';
  const store: TokenStore = {
    get: async () => saved,
    set: async (value) => {
      saved = value;
    },
  };
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const offline = new TypeError('Network request failed');
  fetch.mockRejectedValueOnce(offline);
  const api = new BusinessApi('https://api.test', store, fetch);
  await expect(api.restore()).rejects.toBe(offline);
  expect(saved).toBe('first-session');
  expect(api.signedIn).toBe(false);

  fetch.mockResolvedValueOnce(Response.json({ accessToken: 'signed-in', refreshToken: 'rotated' }));
  await expect(api.restore()).resolves.toBe(true);
  expect(saved).toBe('rotated');
  fetch.mockRejectedValueOnce(offline);
  await api.signOut();
  expect(saved).toBeNull();
  expect(api.signedIn).toBe(false);
  await expect(api.restore()).resolves.toBe(false);
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    '/v1/auth/refresh',
    '/v1/auth/refresh',
    '/v1/auth/logout',
  ]);
});
