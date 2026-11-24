import { createElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DICTIONARIES, fill, LOCALES, pickLocale } from '../src/i18n';

vi.mock('react-native', () => vi.importActual('react-native-web'));

/** Every key path of a dictionary, e.g. "signIn›title" (keys may have dots: "service.updated"). */
const SEP = '›';
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}${SEP}${k}` : k));
}

describe('translations', () => {
  it('PL, UA, RU and EN have the same keys and no empty texts', () => {
    const base = keys(DICTIONARIES.pl).sort();
    for (const locale of LOCALES) {
      expect(keys(DICTIONARIES[locale]).sort(), locale).toEqual(base);
      for (const key of base) {
        const text = key
          .split(SEP)
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], DICTIONARIES[locale]);
        expect(String(text).trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });

  it('the {to} placeholder is in every language', () => {
    for (const locale of LOCALES) {
      expect(DICTIONARIES[locale].signIn.sentEmail).toContain('{to}');
      expect(fill(DICTIONARIES[locale].signIn.sentSms, { to: '+48600100200' })).toContain(
        '+48600100200',
      );
    }
  });

  it('shows UA on the language switcher for a Ukrainian phone locale', async () => {
    const { LanguagePicker } = await import('../src/screens/LanguagePicker');
    const { renderToStaticMarkup } = await vi.importActual<{
      renderToStaticMarkup: (element: ReactElement) => string;
    }>('react-dom/server');
    const locale = pickLocale('UK_ua');
    const markup = renderToStaticMarkup(
      createElement(LanguagePicker, {
        locale,
        t: DICTIONARIES[locale],
        onLocale: () => {},
      }),
    );

    expect(locale).toBe('uk');
    expect(markup).toContain('>UA ▾<');
  });

  it('opens in the phone’s language, Polish otherwise', () => {
    expect(pickLocale('uk-UA')).toBe('uk');
    expect(pickLocale('ru_RU')).toBe('ru');
    expect(pickLocale('en-US')).toBe('en');
    expect(pickLocale('be-BY')).toBe('ru');
    expect(pickLocale('')).toBe('pl');
    expect(pickLocale('xx-UA')).toBe('pl');
    expect(pickLocale('de-DE')).toBe('pl');
    expect(pickLocale(undefined)).toBe('pl');
  });
});
