import { en } from './en';
import { pl, type Dict } from './pl';
import { ru } from './ru';
import { sq } from './sq';
import { tr } from './tr';
import { uk } from './uk';

/** tr (Turkish) and sq (Albanian) cover what clients see; the salon dashboard falls back to English. */
export const LOCALES = ['pl', 'uk', 'ru', 'en', 'tr', 'sq'] as const;
export type Locale = (typeof LOCALES)[number];

/** Languages with the whole salon dashboard translated (its language switch offers these). */
export const DASHBOARD_LOCALES: readonly Locale[] = ['pl', 'uk', 'ru', 'en'];

export const DICTIONARIES: Record<Locale, Dict> = { pl, uk, ru, en, tr, sq };

/** BCP 47 tags for dates, numbers and money. */
export const LOCALE_TAGS: Record<Locale, string> = {
  pl: 'pl-PL',
  uk: 'uk-UA',
  ru: 'ru-RU',
  en: 'en-GB',
  tr: 'tr-TR',
  sq: 'sq-AL',
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Replaces {name} placeholders. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}

/** First supported language in an Accept-Language header, by quality; Polish otherwise. */
export function pickLocale(header: string | null): Locale {
  const wanted = (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...rest] = part.trim().split(';');
      const q = rest.map((r) => r.trim()).find((r) => r.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return {
        lang: tag.slice(0, 2).toLowerCase(),
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((w) => w.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { lang } of wanted) {
    // "ua" is not a language code, but people write it for Ukrainian.
    const code = lang === 'ua' ? 'uk' : lang;
    if (isLocale(code)) return code;
  }
  return 'pl';
}
