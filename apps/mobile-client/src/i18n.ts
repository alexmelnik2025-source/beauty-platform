import type { Locale } from './api';
import { en } from './locales/en';
import { pl, type Dictionary } from './locales/pl';
import { ru } from './locales/ru';
import { sq } from './locales/sq';
import { tr } from './locales/tr';
import { uk } from './locales/uk';

export const DICTIONARIES: Record<Locale, Dictionary> = { pl, uk, ru, en, tr, sq };
export const LOCALES: Locale[] = ['pl', 'uk', 'ru', 'en', 'tr', 'sq'];
/** Each language is named in itself on the switcher. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  pl: 'Polski',
  uk: 'Українська',
  ru: 'Русский',
  en: 'English',
  tr: 'Türkçe',
  sq: 'Shqip',
};

/** A language from the API (it may know more than this app, e.g. tr, sq) → one the app has. */
export function appLocale(value: string): Locale {
  return (LOCALES as string[]).includes(value) ? (value as Locale) : 'en';
}

/** The phone's language if we have it (e.g. "uk-UA" → uk, "be" → ru), otherwise Polish. */
export function pickLocale(tag: string | undefined): Locale {
  const lang = (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  if ((LOCALES as string[]).includes(lang)) return lang as Locale;
  if (lang === 'be') return 'ru';
  return 'pl';
}

/** "Wysłaliśmy kod na {email}." → fills in {email}. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export type { Dictionary };
