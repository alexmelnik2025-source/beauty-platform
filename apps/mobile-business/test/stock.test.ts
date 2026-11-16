import { describe, expect, it } from 'vitest';
import { parseStock } from '../src/stock';

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
