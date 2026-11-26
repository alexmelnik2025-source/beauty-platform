import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, BusinessApi } from '../src/api';

describe('BusinessApi response boundaries', () => {
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  let api: BusinessApi;

  beforeEach(async () => {
    fetchFn.mockReset();
    api = new BusinessApi(
      'https://api.test',
      { get: async () => null, set: async () => {} },
      fetchFn,
    );
    fetchFn.mockResolvedValueOnce(
      Response.json({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresIn: 900,
        user: {
          id: 'staff',
          email: 'staff@example.com',
          name: 'Ewa',
          locale: 'pl',
          emailVerified: true,
        },
      }),
    );
    await api.verifyCode({ email: 'staff@example.com' }, '123456', 'pl');
    fetchFn.mockClear();
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 503])(
    'preserves the HTTP %i status, server message and usable field details',
    async (status) => {
      const detail = { path: 'locationId', message: 'Sprawdź wartość' };
      fetchFn.mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: 'SERVER_ERROR',
              message: 'Żądanie odrzucone',
              requestId: 'trace-id',
              details: [null, { path: 42, message: 'wrong type' }, detail, { path: 'no-message' }],
            },
          },
          { status },
        ),
      );
      await expect(api.requestCode({ email: 'staff@example.com' }, 'pl')).rejects.toMatchObject({
        name: 'ApiError',
        status,
        code: 'SERVER_ERROR',
        message: 'Żądanie odrzucone',
        details: [detail],
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['empty body', ''],
    ['HTML', '<html>Unavailable</html>'],
    ['truncated JSON', '{"error":{"message":'],
    ['missing error field', '{"requestId":"trace-id"}'],
    ['invalid error fields', '{"error":{"code":1,"message":null,"details":"invalid"}}'],
  ])('falls back to the HTTP status for an error with %s', async (_label, body) => {
    fetchFn.mockResolvedValueOnce(new Response(body, { status: 503 }));
    await expect(api.locations('org')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: undefined,
      message: 'HTTP 503',
      details: [],
    });
  });

  it.each([
    ['empty body', ''],
    ['HTML', '<html>Login</html>'],
    ['truncated JSON', '[{"id":"salon"'],
    ['null instead of a list', 'null'],
    ['a string instead of a list', '"salon"'],
  ])('rejects a successful list response containing %s', async (_label, body) => {
    fetchFn.mockResolvedValueOnce(new Response(body));
    const locations = api.locations('org');
    await expect(locations).rejects.toBeInstanceOf(ApiError);
    await expect(locations).rejects.toMatchObject({ status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('accepts 204 for a deletion', async () => {
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.cancelInvitation('org', 'invitation')).resolves.toBeUndefined();
  });

  it('accepts 204 when removing a waitlist entry', async () => {
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.removeFromWaitlist('org', 'salon', 'entry')).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects 204 when the list of salons is required', async () => {
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.locations('org')).rejects.toMatchObject({ name: 'ApiError', status: 204 });
  });

  it('rejects 204 when deleting a reply should return the updated review', async () => {
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.removeReviewReply('org', 'salon', 'review')).rejects.toMatchObject({
      name: 'ApiError',
      status: 204,
    });
  });

  it('reads the public hours when the page includes additional fields', async () => {
    const hours = {
      timezone: 'Europe/Warsaw',
      openingHours: [{ weekday: 4, intervals: [{ start: '09:00', end: '17:00' }] }],
      todayHours: { date: '2026-11-26', intervals: [] },
    };
    fetchFn.mockResolvedValueOnce(Response.json({ ...hours, name: 'Łódź', services: [] }));
    await expect(api.publicHours('salon')).resolves.toEqual(hours);
  });

  it('preserves Polish letters and reserved characters in path segments and query values', async () => {
    const orgId = 'Łódź/Śródmieście?#%';
    const search = 'Żaneta + Łukasz &sort=paid #1';
    const tag = 'stały/50%?';
    fetchFn.mockResolvedValueOnce(Response.json([]));
    await expect(api.customers(orgId, search, 20, 0, tag)).resolves.toEqual([]);
    const url = new URL(fetchFn.mock.calls[0]![0]);
    expect(url.pathname.split('/').map(decodeURIComponent)).toEqual([
      '',
      'v1',
      'organizations',
      orgId,
      'customers',
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '20', search, tag });
    expect(url.hash).toBe('');
  });

  it('preserves a dropped connection while reading a successful JSON list', async () => {
    const offline = new TypeError('Connection closed');
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(offline);
      },
    });
    fetchFn.mockResolvedValueOnce(new Response(body));
    await expect(api.locations('org')).rejects.toBe(offline);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('preserves the HTTP error when a CSV download receives an HTML error page', async () => {
    fetchFn.mockResolvedValueOnce(new Response('<html>Unavailable</html>', { status: 503 }));
    await expect(api.clientsCsv('org', 'pl')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'HTTP 503',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
