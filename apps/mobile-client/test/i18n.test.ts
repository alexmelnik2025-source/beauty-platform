import { describe, expect, it } from 'vitest';
import { appLocale, DICTIONARIES, fill, LOCALES, pickLocale } from '../src/i18n';

/** Every key path of a dictionary, e.g. "signIn.title". */
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('translations', () => {
  it('PL, UA, RU, EN, TR and SQ have the same keys and no empty texts', () => {
    const base = keys(DICTIONARIES.pl).sort();
    for (const locale of LOCALES) {
      expect(keys(DICTIONARIES[locale]).sort(), locale).toEqual(base);
      for (const key of base) {
        const text = key
          .split('.')
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], DICTIONARIES[locale]);
        expect(String(text).trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });

  it('placeholders are in every language', () => {
    for (const locale of LOCALES) {
      const t = DICTIONARIES[locale];
      expect(fill(t.signIn.sent, { email: 'anna@example.com' })).toContain('anna@example.com');
      expect(fill(t.visits.signedInAs, { email: 'anna@example.com' })).toContain(
        'anna@example.com',
      );
      expect(fill(t.visits.with, { staff: 'Kasia' })).toContain('Kasia');
    }
  });

  it('every visit status has a name', () => {
    const statuses = ['held', 'confirmed', 'completed', 'no_show', 'cancelled', 'expired'];
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale].visits.status).sort()).toEqual([...statuses].sort());
    }
  });

  it('opens in the phone’s language, Polish otherwise', () => {
    expect(pickLocale('uk-UA')).toBe('uk');
    expect(pickLocale('ru_RU')).toBe('ru');
    expect(pickLocale('en-US')).toBe('en');
    expect(pickLocale('be-BY')).toBe('ru');
    expect(pickLocale('tr-TR')).toBe('tr');
    expect(pickLocale('sq-AL')).toBe('sq');
    expect(pickLocale('de-DE')).toBe('pl');
    expect(pickLocale(undefined)).toBe('pl');
  });

  it('Turkish and Albanian are translated, not English copies (L5, part 4)', () => {
    const english = DICTIONARIES.en;
    for (const locale of ['tr', 'sq'] as const) {
      const t = DICTIONARIES[locale];
      expect(t.signIn.title).not.toBe(english.signIn.title);
      expect(t.book.confirm).not.toBe(english.book.confirm);
      expect(t.visit.cancelAsk).not.toBe(english.visit.cancelAsk);
      expect(t.bonuses.tab).not.toBe(english.bonuses.tab);
      expect(fill(t.visit.moveAsk, { day: 'X', time: '10:00' })).toContain('10:00');
    }
    expect(appLocale('tr')).toBe('tr');
    expect(appLocale('de')).toBe('en');
  });
});
