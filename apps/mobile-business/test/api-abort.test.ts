import { describe, expect, it } from 'vitest';
import { BusinessApi } from '../src/api';

const methods = ['guardSettings', 'guardedClients', 'reviewSettings', 'reviews'] as const;

describe('aborting business screen reads', () => {
  it.each(methods)('cancels %s with the same signal after session refresh', async (method) => {
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    let started!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const api = new BusinessApi(
      'https://api.test',
      { get: async () => 'refresh-token', set: async () => {} },
      async (url, init) => {
        if (url.endsWith('/auth/refresh')) {
          return Response.json({ accessToken: 'access-token' });
        }
        signals.push(init?.signal);
        if (signals.length === 1) return new Response(null, { status: 401 });
        started();
        return new Promise<Response>((resolve, reject) => {
          if (!init?.signal) return resolve(Response.json({}));
          init.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        });
      },
    );

    const signal = controller.signal;
    const read =
      method === 'reviews'
        ? api.reviews('org', 'salon', {}, signal)
        : api[method]('org', 'salon', signal);
    await retryStarted;
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals).toHaveLength(2);
    for (const received of signals) expect(received).toBe(signal);
    expect(api.signedIn).toBe(true);
  });
});
