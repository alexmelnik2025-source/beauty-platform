import type { ClientAppointment } from './api';

/**
 * Task 80: the client's wishes for a visit — how they want to spend it, a drink, a note
 * for the specialist. Only the questions the salon asks. No React Native here (tested in
 * Vitest, test/wishes.test.ts).
 */
export type VisitWishes = ClientAppointment['wishes'];
export type WishQuestions = ClientAppointment['wishQuestions'];
export type VisitMood = NonNullable<VisitWishes['mood']>;
export type VisitDrink = NonNullable<VisitWishes['drink']>;

export const NO_WISHES: VisitWishes = { mood: null, drink: null, note: null };
export const MOODS: VisitMood[] = ['chat', 'quiet', 'relax'];
export const MOOD_ICON: Record<VisitMood, string> = { chat: '😄', quiet: '🤫', relax: '😌' };
export const DRINK_ICON: Record<VisitDrink, string> = {
  coffee: '☕',
  tea: '🍵',
  water: '💧',
  none: '🙅',
};
export const NOTE_MAX = 200;

/** Does the salon ask anything at all? */
export function asksWishes(q: WishQuestions | null | undefined): q is WishQuestions {
  return Boolean(q && (q.mood || q.drinks.length > 0 || q.note));
}

/** The drinks to offer, plus "nothing" — or none when the salon does not ask. */
export function drinkChoices(q: WishQuestions): VisitDrink[] {
  return q.drinks.length > 0 ? [...new Set(q.drinks), 'none'] : [];
}

/** What is sent: only the questions asked, the note trimmed (empty → null, at most 200). */
export function wishesToSend(w: VisitWishes, q: WishQuestions): VisitWishes {
  // The API counts UTF-16 units. Drop the leading half of an emoji if the cut splits it.
  const note = (w.note ?? '')
    .trim()
    .slice(0, NOTE_MAX)
    .replace(/[\uD800-\uDBFF]$/, '');
  return {
    mood: q.mood ? w.mood : null,
    drink: q.drinks.length > 0 && w.drink && drinkChoices(q).includes(w.drink) ? w.drink : null,
    note: q.note && note ? note : null,
  };
}

/** Task 80f: the picture types the API takes for example photos. */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The type a picked photo is sent as: a supported picker or blob type, otherwise JPEG (the
 * phone's picker converts other formats, such as HEIC from an iPhone, to JPEG).
 */
export function photoType(mimeType: string | null | undefined, blobType: string): string {
  const picked = mimeType?.toLowerCase();
  if (picked && PHOTO_TYPES.includes(picked)) return picked;
  const uploaded = blobType.toLowerCase();
  return PHOTO_TYPES.includes(uploaded) ? uploaded : 'image/jpeg';
}
