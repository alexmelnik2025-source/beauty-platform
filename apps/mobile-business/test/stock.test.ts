import { describe, expect, it } from 'vitest';
import { parseStock, toOrderNames } from '../src/stock';

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
