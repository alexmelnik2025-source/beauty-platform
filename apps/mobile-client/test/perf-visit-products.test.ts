import { expect, it, vi } from 'vitest';
import { ClientApi, type VisitProducts } from '../src/api';
import { reserveOne } from '../src/screens/VisitProductsCard';

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../src/ui', () => ({ colors: {} }));

function reservation(id: string): VisitProducts['reservations'][number] {
  return {
    id,
    productId: 'serum',
    name: 'Serum',
    quantity: 1,
    status: 'reserved',
    photoId: null,
    unitPriceGrosze: 1200,
    totalGrosze: 1200,
    createdAt: '2026-11-26T12:00:00Z',
  };
}

it.each([true, false])('reconciles a lost confirmation in one pass (saved: %s)', async (saved) => {
  const api = new ClientApi('', { get: async () => null, set: async () => {} });
  const previous = Array.from({ length: 100 }, (_, i) => reservation(String(i)));
  const current = [...previous, ...(saved ? [reservation('new')] : [])];
  const list = (reservations: VisitProducts['reservations']): VisitProducts => ({
    currency: 'PLN',
    canChange: true,
    available: [],
    reservations,
    totalGrosze: 1200 * reservations.length,
  });
  let comparisons = 0;
  const before = list(
    previous.map((r) => ({
      ...r,
      get id() {
        comparisons++;
        return r.id;
      },
    })),
  );
  const acknowledged = list([...previous, reservation('new')]);
  const read = vi.spyOn(api, 'visitProducts').mockResolvedValue(list(current));
  const write = vi.spyOn(api, 'reserveProduct').mockResolvedValue(acknowledged);
  write.mockRejectedValueOnce(new TypeError('lost response'));
  const reserve = reserveOne(api, 'visit', 'serum', before);
  await expect(reserve(false)).rejects.toThrow('lost response');
  await expect(reserve(true)).resolves.toEqual(acknowledged);
  expect(read).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(saved ? 1 : 2);
  expect(comparisons).toBeLessThanOrEqual(previous.length);
});
