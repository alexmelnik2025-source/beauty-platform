import { describe, expect, it } from 'vitest';
import { en } from '../../web/lib/i18n/en';
import { pl } from '../../web/lib/i18n/pl';
import { ru } from '../../web/lib/i18n/ru';
import { uk } from '../../web/lib/i18n/uk';

function leafPaths(value: object, prefix = ''): string[] {
  return Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return child && typeof child === 'object' ? leafPaths(child, path) : [path];
    })
    .sort();
}

describe('web translations', () => {
  it('keeps the same keys in Polish, Ukrainian, Russian and English', () => {
    const reference = leafPaths(pl);
    expect(leafPaths(uk)).toEqual(reference);
    expect(leafPaths(ru)).toEqual(reference);
    expect(leafPaths(en)).toEqual(reference);
  });
});
