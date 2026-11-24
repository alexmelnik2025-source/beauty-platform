import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientApi, type Hold } from '../src/api';

const hold: Hold = {
  holdId: 'hold/1',
  holdToken: 'hold-token-0123456789abcdef',
  expiresAt: '2026-11-10T10:10:00Z',
  start: '2026-11-10T10:00:00Z',
  end: '2026-11-10T10:45:00Z',
  date: '2026-11-10',
  time: '11:00',
  staffId: 's1',
  staffName: 'Kasia',
  serviceName: 'Strzyżenie męskie',
  priceGrosze: 9000,
  listPriceGrosze: null,
  happyHourPercent: null,
  currency: 'PLN',
};
const contact = {
  name: 'Anna',
  phone: '+48600100200',
  email: 'anna@example.com',
  acceptTerms: true,
  marketingConsent: false,
} as const;
const wishes = { mood: 'quiet', drink: 'tea', note: 'Short cut' } as const;

interface RequestCase {
  name: string;
  call: (api: ClientApi) => Promise<unknown>;
  path: string;
  method: string;
  signedIn: boolean;
  body?: unknown;
  headers?: Record<string, string>;
}

const requests: RequestCase[] = [
  {
    name: 'sendBookingCode',
    call: (api) => api.sendBookingCode(hold, contact, 'uk'),
    path: '/v1/public/holds/hold%2F1/code',
    method: 'POST',
    signedIn: false,
    body: { ...contact, holdToken: hold.holdToken, locale: 'uk', codeChannel: 'email' },
  },
  {
    name: 'confirmBooking',
    call: (api) => api.confirmBooking(hold, '012345', wishes, true),
    path: '/v1/public/holds/hold%2F1/confirm',
    method: 'POST',
    signedIn: false,
    body: { holdToken: hold.holdToken, code: '012345', wishes, payNoticeAccepted: true },
    headers: { 'idempotency-key': 'confirm-hold/1-012345-notice' },
  },
  {
    name: 'confirmBooking without optional fields',
    call: (api) => api.confirmBooking(hold, '012345'),
    path: '/v1/public/holds/hold%2F1/confirm',
    method: 'POST',
    signedIn: false,
    body: { holdToken: hold.holdToken, code: '012345' },
    headers: { 'idempotency-key': 'confirm-hold/1-012345' },
  },
  {
    name: 'releaseHold',
    call: (api) => api.releaseHold(hold),
    path: '/v1/public/holds/hold%2F1/release',
    method: 'POST',
    signedIn: false,
    body: { holdToken: hold.holdToken },
  },
  {
    name: 'holdPhotos',
    call: (api) => api.holdPhotos(hold),
    path: '/v1/public/holds/hold%2F1/photos',
    method: 'GET',
    signedIn: false,
    headers: { 'x-hold-token': hold.holdToken },
  },
  {
    name: 'freeToday',
    call: (api) => api.freeToday('salon/1'),
    path: '/v1/public/locations/salon%2F1/free-today',
    method: 'GET',
    signedIn: false,
  },
  {
    name: 'salonReviews',
    call: (api) => api.salonReviews('salon/1', { staffId: 'a&b', rating: 4, before: 'next/page' }),
    path: '/v1/public/locations/salon%2F1/reviews?staffId=a%26b&rating=4&before=next%2Fpage',
    method: 'GET',
    signedIn: false,
  },
  {
    name: 'salonReviews without filters',
    call: (api) => api.salonReviews('salon/1'),
    path: '/v1/public/locations/salon%2F1/reviews',
    method: 'GET',
    signedIn: false,
  },
  {
    name: 'calendarLink',
    call: (api) => api.calendarLink('visit/1'),
    path: '/v1/client/appointments/visit%2F1/calendar-link',
    method: 'POST',
    signedIn: true,
    body: {},
  },
  {
    name: 'loyalty',
    call: (api) => api.loyalty(),
    path: '/v1/client/loyalty',
    method: 'GET',
    signedIn: true,
  },
  {
    name: 'visitSummary',
    call: (api) => api.visitSummary(),
    path: '/v1/client/me/summary',
    method: 'GET',
    signedIn: true,
  },
  {
    name: 'updateWishes',
    call: (api) => api.updateWishes('visit/1', wishes),
    path: '/v1/client/appointments/visit%2F1/wishes',
    method: 'PUT',
    signedIn: true,
    body: wishes,
  },
];

describe.each(requests)('$name', (request) => {
  const origin = 'https://api.test';
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  let api: ClientApi;

  beforeEach(async () => {
    fetchFn.mockReset();
    api = new ClientApi(origin, { get: async () => null, set: async () => {} }, fetchFn);
    fetchFn.mockResolvedValueOnce(Response.json({ person: { locale: 'uk' }, token: 'session' }));
    await api.verifyCode('anna@example.com', '123456', 'uk');
    fetchFn.mockClear();
  });

  it('sends the expected request and reads the response', async () => {
    const result = { id: 'result' };
    const release = request.name === 'releaseHold';
    fetchFn.mockResolvedValueOnce(
      release ? new Response(null, { status: 204 }) : Response.json(result),
    );
    await expect(request.call(api)).resolves.toEqual(release ? undefined : result);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(origin + request.path);
    expect(init?.method).toBe(request.method);
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe(request.signedIn ? 'Bearer session' : null);
    // Known CW issue: the client omits the selected language even after sign-in.
    expect(headers.get('accept-language')).toBeNull();
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      expect(headers.get(name)).toBe(value);
    }
    if (request.body === undefined) {
      expect(headers.has('content-type')).toBe(false);
      expect(init?.body).toBeUndefined();
    } else {
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toStrictEqual(request.body);
    }
  });

  it('handles the server error with its code and field path', async () => {
    const error = {
      code: 'VALIDATION_ERROR',
      message: 'Invalid value',
      details: [{ path: 'id', message: 'Invalid ID' }],
    };
    fetchFn.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
    if (request.name === 'releaseHold') await expect(request.call(api)).resolves.toBeUndefined();
    else
      await expect(request.call(api)).rejects.toMatchObject({
        name: 'ApiError',
        status: 400,
        ...error,
      });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('handles a dropped connection without repeating the request', async () => {
    const offline = new TypeError('Network request failed');
    fetchFn.mockRejectedValueOnce(offline);
    if (request.name === 'releaseHold') await expect(request.call(api)).resolves.toBeUndefined();
    else await expect(request.call(api)).rejects.toBe(offline);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
