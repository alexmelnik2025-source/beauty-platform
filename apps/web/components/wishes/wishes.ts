/** Task 80: the client's wishes for a visit — shared icons for the cabinet and booking. */

export type VisitMood = 'chat' | 'quiet' | 'relax';
export type VisitDrink = 'coffee' | 'tea' | 'water' | 'none';
export type OfferedDrink = Exclude<VisitDrink, 'none'>;

export interface VisitWishes {
  mood: VisitMood | null;
  drink: VisitDrink | null;
  note: string | null;
}

export const MOODS: VisitMood[] = ['chat', 'quiet', 'relax'];
export const OFFERED_DRINKS: OfferedDrink[] = ['coffee', 'tea', 'water'];

export const MOOD_ICON: Record<VisitMood, string> = { chat: '😄', quiet: '🤫', relax: '😌' };
export const DRINK_ICON: Record<VisitDrink, string> = {
  coffee: '☕',
  tea: '🍵',
  water: '💧',
  none: '🙅',
};

export function hasWishes(w: VisitWishes | null | undefined): w is VisitWishes {
  return Boolean(w && (w.mood || w.drink || w.note));
}
