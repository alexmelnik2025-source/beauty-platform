import { expect, it, vi } from 'vitest';
import { ClientApi } from '../src/api';
import { reserveBookingProducts } from '../src/screens/BookingScreen';

vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('expo-secure-store', () => ({}));
vi.mock('expo-image-picker', () => ({}));

it('counts confirmed products separately and continues after a lost reservation response', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError('Connection interrupted'))
    .mockResolvedValueOnce(Response.json({}));
  const api = new ClientApi('', { get: async () => null, set: async () => {} }, fetch);

  await expect(reserveBookingProducts(api, 'visit', ['oil', 'wax'])).resolves.toEqual({
    confirmed: 1,
    unconfirmed: 1,
  });
  expect(
    fetch.mock.calls.map(([url, init]) => [
      url,
      init?.method,
      JSON.parse(String(init?.body)).productId,
    ]),
  ).toEqual([
    ['/v1/public/appointments/visit/products', 'POST', 'oil'],
    ['/v1/public/appointments/visit/products', 'POST', 'wax'],
  ]);
});

it('reports an unconfirmed product when none could be put aside', async () => {
  const reserveByToken = vi
    .fn<ClientApi['reserveByToken']>()
    .mockRejectedValue(new Error('Sold out'));
  await expect(reserveBookingProducts({ reserveByToken }, 'visit', ['wax'])).resolves.toEqual({
    confirmed: 0,
    unconfirmed: 1,
  });
  expect(reserveByToken).toHaveBeenCalledExactlyOnceWith('visit', 'wax');
});
