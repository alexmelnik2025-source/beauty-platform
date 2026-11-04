import { z } from 'zod';
import type { Location, VisitDrink, VisitMood } from '../generated/prisma/client';

/**
 * Task 80: the client's wishes for a visit — how to spend it (chat / quiet / relax), a drink
 * the salon offers, a short note for the specialist. Every question is switched on by the
 * salon (Location.askMood / askDrink + drinks / askNote); answers to questions the salon does
 * not ask are dropped, so a page loaded before the salon changed its settings still books.
 */

export const visitMoodSchema = z.enum(['chat', 'quiet', 'relax'] satisfies VisitMood[]);
export const visitDrinkSchema = z.enum(['coffee', 'tea', 'water', 'none'] satisfies VisitDrink[]);
/** What a salon can offer: every drink except "none". */
export const offeredDrinkSchema = z.enum(['coffee', 'tea', 'water']);

/** The client's answers; a missing or null answer means "skipped". */
export const visitWishesInputSchema = z.object({
  mood: visitMoodSchema.nullable().optional(),
  drink: visitDrinkSchema.nullable().optional(),
  /** E.g. "wrażliwa skóra głowy"; an empty text clears it. */
  note: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
});
export type VisitWishesInput = z.infer<typeof visitWishesInputSchema>;

export const visitWishesSchema = z
  .strictObject({
    mood: visitMoodSchema.nullable(),
    drink: visitDrinkSchema.nullable(),
    note: z.string().nullable(),
  })
  .describe("The client's wishes for the visit (task 80); null = not answered");

export const wishQuestionsSchema = z
  .strictObject({
    mood: z.boolean().describe('Ask how the client wants to spend the visit'),
    drinks: z
      .array(offeredDrinkSchema)
      .describe('Drinks to offer; empty = the drink question is not asked'),
    note: z.boolean().describe('Ask for a short note for the specialist (up to 200 characters)'),
  })
  .describe('Questions the salon asks on the last booking step (task 80)');

export type WishQuestions = z.infer<typeof wishQuestionsSchema>;
export type VisitWishes = z.infer<typeof visitWishesSchema>;

type AskingLocation = Pick<Location, 'askMood' | 'askDrink' | 'drinks' | 'askNote'>;

export function wishQuestions(location: AskingLocation): WishQuestions {
  return {
    mood: location.askMood,
    drinks: location.askDrink
      ? location.drinks.filter((d): d is Exclude<VisitDrink, 'none'> => d !== 'none')
      : [],
    note: location.askNote,
  };
}

/**
 * The answers to store, as database fields: only for questions the salon asks; a drink the
 * salon does not offer is dropped ("none" is always allowed when drinks are asked). Fields
 * of skipped questions are left out, so remembered answers are not wiped by a skip.
 */
export function acceptedWishes(
  location: AskingLocation,
  input: VisitWishesInput | undefined,
): { wishMood?: VisitMood | null; wishDrink?: VisitDrink | null; wishNote?: string | null } {
  if (!input) return {};
  const asked = wishQuestions(location);
  const out: {
    wishMood?: VisitMood | null;
    wishDrink?: VisitDrink | null;
    wishNote?: string | null;
  } = {};
  if (asked.mood && input.mood !== undefined) out.wishMood = input.mood;
  if (
    asked.drinks.length > 0 &&
    input.drink !== undefined &&
    (input.drink === null || input.drink === 'none' || asked.drinks.includes(input.drink))
  ) {
    out.wishDrink = input.drink;
  }
  if (asked.note && input.note !== undefined) out.wishNote = input.note;
  return out;
}

export function toWishes(row: {
  wishMood: VisitMood | null;
  wishDrink: VisitDrink | null;
  wishNote: string | null;
}): VisitWishes {
  return { mood: row.wishMood, drink: row.wishDrink, note: row.wishNote };
}
