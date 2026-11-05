import { SPOKEN, type Spoken } from './types';

/** Task 192: the languages chosen in the catalogue last time, remembered on this device. */
const LANGUAGES_KEY = 'beauty.catalogue.languages';

export function rememberedLanguages(): Spoken[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(LANGUAGES_KEY) ?? '[]');
    return Array.isArray(saved) ? SPOKEN.filter((code) => saved.includes(code)) : [];
  } catch {
    return [];
  }
}

export function rememberLanguages(codes: Spoken[]): void {
  try {
    window.localStorage.setItem(LANGUAGES_KEY, JSON.stringify(codes));
  } catch {
    // Private mode or blocked storage: the choice just is not remembered.
  }
}

/**
 * Task 160c: specialists speaking one of the languages chosen in the catalogue come first; the
 * salon's own order is kept otherwise.
 */
export function speakersFirst<T extends { languages?: Spoken[] }>(
  staff: T[],
  chosen: Spoken[],
): T[] {
  if (chosen.length === 0) return staff;
  const speaks = (s: T) => (s.languages ?? []).some((code) => chosen.includes(code));
  return [...staff.filter(speaks), ...staff.filter((s) => !speaks(s))];
}
