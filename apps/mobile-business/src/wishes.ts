import type { AppointmentDetail } from './api';
import type { Dictionary } from './i18n';

type Wishes = AppointmentDetail['wishes'];

export const MOOD_ICON = { chat: '😄', quiet: '🤫', relax: '😌' } as const;
export const DRINK_ICON = { coffee: '☕', tea: '🍵', water: '💧', none: '🙅' } as const;
/** Task 320: what a salon may have to drink — the server allows only these. */
export const OFFERED_DRINKS = ['coffee', 'tea', 'water'] as const;
export type OfferedDrink = (typeof OFFERED_DRINKS)[number];

/**
 * Task 80: the client's wishes in the visit card, one line each — "🤫 Woli ciszę",
 * "☕ Kawa", "✍️ <note>". Nothing answered → no lines. No React Native here (tested in Vitest).
 */
export function wishLines(wishes: Wishes | null | undefined, v: Dictionary['visit']): string[] {
  if (!wishes) return [];
  const lines: string[] = [];
  if (wishes.mood) lines.push(`${MOOD_ICON[wishes.mood]} ${v.mood[wishes.mood]}`);
  if (wishes.drink) lines.push(`${DRINK_ICON[wishes.drink]} ${v.drink[wishes.drink]}`);
  if (wishes.note) lines.push(`✍️ ${wishes.note}`);
  return lines;
}
