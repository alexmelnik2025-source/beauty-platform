import type { Locale } from './api';
import { en } from './locales/en';
import { pl, type Dictionary } from './locales/pl';
import { ru } from './locales/ru';
import { uk } from './locales/uk';

export const DICTIONARIES: Record<Locale, Dictionary> = { pl, uk, ru, en };
export const LOCALES: Locale[] = ['pl', 'uk', 'ru', 'en'];
/** Each language is named in itself on the switcher. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  pl: 'Polski',
  uk: 'Українська',
  ru: 'Русский',
  en: 'English',
};

/** The phone's language if we have it (e.g. "uk-UA" → uk, "be" → ru), otherwise Polish. */
export function pickLocale(tag: string | undefined): Locale {
  const lang = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  if (lang === 'uk' || lang === 'ru' || lang === 'en' || lang === 'pl') return lang;
  if (lang === 'be') return 'ru';
  return 'pl';
}

/** "Wysłaliśmy kod na {to}." → fills in {to}. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export type { Dictionary };
