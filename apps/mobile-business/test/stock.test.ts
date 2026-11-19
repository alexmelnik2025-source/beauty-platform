import { describe, expect, it } from 'vitest';
import { orderQuantity, orderText, parseStock, toOrderNames } from '../src/stock';

describe('parseStock (task 431)', () => {
  it('empty means the pieces are not counted', () => {
    expect(parseStock('')).toBeNull();
    expect(parseStock('  ')).toBeNull();
  });

  it('reads whole pieces', () => {
    expect(parseStock('0')).toBe(0);
    expect(parseStock(' 12 ')).toBe(12);
    expect(parseStock('100000')).toBe(100_000);
  });

  it('refuses anything else', () => {
    expect(parseStock('-1')).toBeUndefined();
    expect(parseStock('1,5')).toBeUndefined();
    expect(parseStock('abc')).toBeUndefined();
    expect(parseStock('100001')).toBeUndefined();
  });
});

describe('toOrderNames (task 465)', () => {
  const state = (x: { left: number }) => (x.left === 0 ? 'Brak' : `zostało ${x.left}`);

  it('without suppliers keeps the plain list', () => {
    expect(
      toOrderNames(
        [
          { name: 'Pomada', supplier: null, left: 0 },
          { name: 'Szampon', supplier: null, left: 3 },
        ],
        state,
        'bez dostawcy',
      ),
    ).toBe('Pomada (Brak), Szampon (zostało 3)');
  });

  it('groups by supplier in any letter case, alphabetically, the rest last', () => {
    expect(
      toOrderNames(
        [
          { name: 'Szampon', supplier: null, left: 3 },
          { name: 'Pomada', supplier: 'Hairgum', left: 0 },
          { name: 'Wosk', supplier: 'Barber Hurt', left: 5 },
          { name: 'Glinka', supplier: 'hairgum', left: 1 },
        ],
        state,
        'bez dostawcy',
      ),
    ).toBe(
      'Barber Hurt — Wosk (zostało 5); Hairgum — Pomada (Brak), Glinka (zostało 1); bez dostawcy — Szampon (zostało 3)',
    );
  });
});

describe('orderQuantity (task 473)', () => {
  it('orders enough for 30 days at the last pace', () => {
    expect(orderQuantity({ stockQuantity: 0, lowStockAt: null }, 2)).toBe(2);
    expect(orderQuantity({ stockQuantity: 1, lowStockAt: 1 }, 10)).toBe(9);
  });

  it('gets above "Kończy się przy" when little is sold, never less than one', () => {
    expect(orderQuantity({ stockQuantity: 3, lowStockAt: 3 }, 0)).toBe(1);
    expect(orderQuantity({ stockQuantity: 0, lowStockAt: 5 }, 0)).toBe(6);
    expect(orderQuantity({ stockQuantity: 0, lowStockAt: null }, 0)).toBe(1);
    expect(orderQuantity({ stockQuantity: 8, lowStockAt: 2 }, 3)).toBe(1);
  });
});

describe('orderText (task 473)', () => {
  const labels = { title: 'Zamówienie', noSupplier: 'bez dostawcy', pieces: '{n} szt.' };
  const product = (
    id: string,
    name: string,
    supplier: string | null,
    stock: number,
    low: number | null,
  ) => ({
    id,
    name,
    supplier,
    stockQuantity: stock,
    lowStockAt: low,
  });

  it('without suppliers is one list', () => {
    expect(
      orderText(
        [product('a', 'Pomada', null, 0, null), product('b', 'Szampon', null, 3, 3)],
        new Map([['a', 2]]),
        labels,
      ),
    ).toBe('Zamówienie:\n- Pomada — 2 szt.\n- Szampon — 1 szt.');
  });

  it('is one block per supplier, alphabetically, the rest last', () => {
    expect(
      orderText(
        [
          product('s', 'Szampon', null, 3, 3),
          product('p', 'Pomada', 'Hairgum', 0, null),
          product('w', 'Wosk', 'Barber Hurt', 5, 5),
          product('g', 'Glinka', 'hairgum', 1, 1),
        ],
        new Map([['p', 2]]),
        labels,
      ),
    ).toBe(
      'Zamówienie — Barber Hurt:\n- Wosk — 1 szt.\n\n' +
        'Zamówienie — Hairgum:\n- Pomada — 2 szt.\n- Glinka — 1 szt.\n\n' +
        'Zamówienie — bez dostawcy:\n- Szampon — 1 szt.',
    );
  });
});
