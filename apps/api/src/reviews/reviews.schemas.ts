import { CSV_LOCALES } from '../reports/visits-csv';
import { z } from 'zod';

/** Task 165b: the salon's review settings. */
export const updateReviewSettingsSchema = z
  .object({
    version: z.number().int().min(0).describe('0 before the first save, then the returned version'),
    enabled: z.boolean().describe('Clients may review visits that took place; reviews are public'),
    requestHours: z
      .number()
      .int()
      .min(1)
      .max(72)
      .describe('The client is asked for a review this many hours after the visit ends'),
  })
  .strict();
export type UpdateReviewSettingsInput = z.infer<typeof updateReviewSettingsSchema>;

/** The client's review of one visit. */
export const writeReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5).describe('1–5 stars for the specialist'),
    text: z
      .string()
      .trim()
      .max(1000)
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .describe('Optional words; an empty text removes them'),
  })
  .strict();
export type WriteReviewInput = z.infer<typeof writeReviewSchema>;

/** Task 211: the salon's public answer under a review. */
export const replyReviewSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe('Shown under the review on the salon page and to the client'),
  })
  .strict();
export type ReplyReviewInput = z.infer<typeof replyReviewSchema>;

export const listReviewsQuerySchema = z.object({
  staffId: z.uuid().optional().describe('Only reviews of this specialist'),
  before: z
    .string()
    .uuid()
    .optional()
    .describe('Next page: the id of the last review already shown'),
  rating: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Task 380: only reviews with this many stars'),
});
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;

/** The cabinet's list: also "Bez odpowiedzi" (task 382). */
export const salonReviewsQuerySchema = listReviewsQuerySchema.extend({
  unanswered: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .describe('Task 382: only reviews the salon has not answered yet'),
});
export type SalonReviewsQuery = z.infer<typeof salonReviewsQuerySchema>;

/** Task 407: the language of the reviews CSV's column names. */
export const reviewsCsvQuerySchema = z.object({ locale: z.enum(CSV_LOCALES).default('pl') });
export type ReviewsCsvQuery = z.infer<typeof reviewsCsvQuerySchema>;
