import { describe, expect, it } from 'vitest';
import { DICTIONARIES } from '../src/i18n';

/** A translation can reorder values, but must keep the names provided by the screen. */
function placeholders(dictionary: object, prefix = ''): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(dictionary)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      const names = Array.from(value.matchAll(/\{([^{}]+)\}/g), (match) => match[1]!);
      if (names.length) result[path] = [...new Set(names)].sort();
    } else {
      Object.assign(result, placeholders(value, path));
    }
  }
  return result;
}

describe('localized values on client screens', () => {
  const expected = placeholders(DICTIONARIES.pl);

  it.each(['en', 'uk', 'ru'] as const)('preserves all template parameters in %s', (locale) => {
    expect(placeholders(DICTIONARIES[locale])).toEqual(expected);
  });
});
