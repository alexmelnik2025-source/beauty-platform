import type { StaffList } from './api';

/**
 * Task 96: "Mój profil" in the business app — the specialist chooses the languages they speak
 * with clients (shown on the booking page and the "Mówi po" filter). No React Native here,
 * so it is tested in Vitest (test/profile.test.ts). The server checks it is their own profile.
 */

export type SpokenLanguage = StaffList[number]['languages'][number];

/** In the order clients see them; the names are written in the language itself. */
export const SPOKEN: { code: SpokenLanguage; flag: string; name: string }[] = [
  { code: 'pl', flag: '🇵🇱', name: 'Polski' },
  { code: 'uk', flag: '🇺🇦', name: 'Українська' },
  { code: 'ru', flag: '🇷🇺', name: 'Русский' },
  { code: 'be', flag: '🇧🇾', name: 'Беларуская' },
  { code: 'en', flag: '🇬🇧', name: 'English' },
];

/** Tap a language: on if it was off, off if it was on; always in the clients' order. */
export function toggleLanguage(list: SpokenLanguage[], code: SpokenLanguage): SpokenLanguage[] {
  const next = list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
  return SPOKEN.map((l) => l.code).filter((c) => next.includes(c));
}

/** Did anything change compared with what was saved? (Order does not matter.) */
export function languagesChanged(saved: SpokenLanguage[], chosen: SpokenLanguage[]): boolean {
  return saved.length !== chosen.length || saved.some((c) => !chosen.includes(c));
}

/** "🇵🇱 🇬🇧" for the profile line; "" when none is chosen. */
export function flags(list: SpokenLanguage[]): string {
  return SPOKEN.filter((l) => list.includes(l.code))
    .map((l) => l.flag)
    .join(' ');
}
