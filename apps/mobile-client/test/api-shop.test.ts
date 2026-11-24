import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientApi } from '../src/api';

interface RequestCase {
  name: string;
  call: (api: ClientApi) => Promise<unknown>;
  path: string;
  method: string;
  signedIn: boolean;
  body?: unknown;
}

const requests: RequestCase[] = [
  {
    name: 'shop',
    call: (api) => api.shop({ page: 3, q: '  oil & wax  ', category: 'styling' }),
    path: '/v1/public/shop/products?page=3&pageSize=24&q=oil+%26+wax&category=styling',
    method: 'GET',
    signedIn: false,
  },
  {
    name: 'shopProduct',
    call: (api) => api.shopProduct('card/1'),
    path: '/v1/public/shop/products/card%2F1',
    method: 'GET',
    signedIn: false,
  },
  {
    name: 'reserveByToken',
    call: (api) => api.reserveByToken('manage/1', 'product/2'),
    path: '/v1/public/appointments/manage%2F1/products',
    method: 'POST',
    signedIn: false,
    body: { productId: 'product/2', quantity: 1 },
  },
  {
    name: 'reserveForNext',
    call: (api) => api.reserveForNext('visit/1', 'product/2'),
    path: '/v1/client/appointments/visit%2F1/products/next',
    method: 'POST',
    signedIn: true,
    body: { productId: 'product/2', quantity: 1 },
  },
  {
    name: 'reserveProduct',
    call: (api) => api.reserveProduct('visit/1', 'product/2'),
    path: '/v1/client/appointments/visit%2F1/products',
    method: 'POST',
    signedIn: true,
    body: { productId: 'product/2', quantity: 1 },
  },
  {
    name: 'unreserveProduct',
    call: (api) => api.unreserveProduct('visit/1', 'reservation/2'),
    path: '/v1/client/appointments/visit%2F1/products/reservation%2F2',
    method: 'DELETE',
    signedIn: true,
  },
  {
    name: 'usedProducts',
    call: (api) => api.usedProducts('visit/1'),
    path: '/v1/client/appointments/visit%2F1/products/used',
    method: 'GET',
    signedIn: true,
  },
  {
    name: 'visitProducts',
    call: (api) => api.visitProducts('visit/1'),
    path: '/v1/client/appointments/visit%2F1/products',
    method: 'GET',
    signedIn: true,
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
    fetchFn.mockResolvedValueOnce(Response.json(result));
    await expect(request.call(api)).resolves.toEqual(result);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(origin + request.path);
    expect(init?.method).toBe(request.method);
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe(request.signedIn ? 'Bearer session' : null);
    // Known CW issue: the client omits the selected language even after sign-in.
    expect(headers.get('accept-language')).toBeNull();
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
    await expect(request.call(api)).rejects.toBe(offline);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

it('currently returns null if the shop response stream breaks after HTTP 200', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('Connection reset while reading the body'));
    },
  });
  const api = new ClientApi(
    'https://api.test',
    { get: async () => null, set: async () => {} },
    async () => new Response(body),
  );

  // Known CW issue: the screen expects a ShopList or a rejected request.
  await expect(api.shop()).resolves.toBeNull();
});
