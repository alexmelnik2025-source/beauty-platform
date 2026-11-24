import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessApi, type Locale } from '../../src/api';

interface RequestCase {
  name: string;
  method: string;
  path: string;
  call: (api: BusinessApi) => Promise<unknown>;
  body?: unknown;
  csvFile?: string;
  noContent?: boolean;
  publicHours?: boolean;
}

export function checkRequests(title: string, locale: Locale, cases: RequestCase[]) {
  describe.each(cases)(title + ' / $name ($method $path)', (request) => {
    const origin = 'https://api.test';
    const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    let api: BusinessApi;

    beforeEach(async () => {
      fetchFn.mockReset();
      api = new BusinessApi(origin, { get: async () => null, set: async () => {} }, fetchFn);
      fetchFn.mockResolvedValueOnce(
        Response.json({ accessToken: 'access', refreshToken: 'refresh' }),
      );
      await api.verifyCode({ email: 'staff@example.com' }, '123456', locale);
      fetchFn.mockClear();
    });

    it('sends the request and reads the response', async () => {
      const hours = {
        timezone: 'Europe/Warsaw',
        openingHours: [],
        todayHours: { date: '2026-11-24', intervals: [] },
      };
      const json = request.publicHours ? { ...hours, name: 'Salon' } : { id: 'result' };
      const response = request.csvFile
        ? new Response('Date,Total')
        : request.noContent
          ? new Response(null, { status: 204 })
          : Response.json(json);
      fetchFn.mockResolvedValueOnce(response);
      const result = await request.call(api);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(url).toBe(origin + request.path);
      expect(init?.method).toBe(request.method);
      const headers = new Headers(init?.headers);
      expect(headers.get('accept-language')).toBe(request.csvFile ? 'en' : locale);
      expect(headers.get('accept')).toBe(request.csvFile ? 'text/csv' : 'application/json');
      expect(headers.get('authorization')).toBe(request.publicHours ? null : 'Bearer access');
      if (request.body instanceof Blob) {
        expect(headers.get('content-type')).toBe(request.body.type);
        expect(init?.body).toBe(request.body);
      } else if (request.body !== undefined) {
        expect(headers.get('content-type')).toBe('application/json');
        expect(JSON.parse(String(init?.body))).toStrictEqual(request.body);
      } else {
        expect(headers.has('content-type')).toBe(false);
        expect(init?.body).toBeUndefined();
      }
      if (request.csvFile)
        expect(result).toEqual({ fileName: request.csvFile, csv: '\uFEFFDate,Total' });
      else if (request.noContent) expect(result).toBeUndefined();
      else expect(result).toEqual(request.publicHours ? hours : json);
    });

    it('preserves the server error and its field path', async () => {
      const error = {
        code: 'VALIDATION_ERROR',
        message: 'Invalid value',
        details: [{ path: 'version', message: 'Expected integer' }],
      };
      fetchFn.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
      await expect(request.call(api)).rejects.toMatchObject({
        name: 'ApiError',
        status: 400,
        ...error,
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('propagates a dropped connection without repeating the request', async () => {
      const offline = new TypeError('Network request failed');
      fetchFn.mockRejectedValueOnce(offline);
      await expect(request.call(api)).rejects.toBe(offline);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });
}
