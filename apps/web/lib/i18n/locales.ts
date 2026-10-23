import { en } from './en';
import { pl, type Dict } from './pl';
import { ru } from './ru';
import { uk } from './uk';

export const LOCALES = ['pl', 'uk', 'ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DICTIONARIES: Record<Locale, Dict> = { pl, uk, ru, en };

/** BCP 47 tags for dates, numbers and money. */
export const LOCALE_TAGS: Record<Locale, string> = {
  pl: 'pl-PL',
  uk: 'uk-UA',
  ru: 'ru-RU',
  en: 'en-GB',
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Replaces {name} placeholders. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}
