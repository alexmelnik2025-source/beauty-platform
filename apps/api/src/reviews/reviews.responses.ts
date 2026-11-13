import { z } from 'zod';
import { responseSchema } from '../common/openapi';

export const reviewSettingsSchema = responseSchema(
  'ReviewSettings',
  z.strictObject({
    enabled: z.boolean(),
    requestHours: z.number().int(),
    version: z.number().int().describe('0 = never saved (defaults: off)'),
  }),
);
export type ReviewSettingsResponse = z.infer<typeof reviewSettingsSchema>;

/** Task 211: the salon's answer under the review. */
const replyFields = {
  reply: z.string().nullable().describe('The salon’s public answer; null without one'),
  repliedAt: z.string().nullable(),
};

const ratingSummary = {
  count: z.number().int(),
  average: z.number().nullable().describe('Average stars, one decimal; null without reviews'),
};

/** Task 380: the reviews by stars — the bars above the list and the "★ 5 (12)" filter. */
const stars = z
  .array(z.number().int())
  .describe(
    'Task 380: how many reviews have 1, 2, 3, 4 and 5 stars (index 0 = one star); with `staffId`, without `rating`',
  );

/** The salon page: reviews without any client data. */
export const publicReviewsSchema = responseSchema(
  'PublicReviews',
  z.strictObject({
    enabled: z.boolean().describe('false: the salon does not collect reviews (nothing to show)'),
    ...ratingSummary,
    stars,
    staff: z
      .array(
        z.strictObject({
          staffId: z.string(),
          displayName: z.string(),
          ...ratingSummary,
        }),
      )
      .describe('Active specialists with at least one review, salon order'),
    items: z.array(
      z.strictObject({
        id: z.string(),
        rating: z.number().int(),
        text: z.string().nullable(),
        staffId: z.string(),
        staffName: z.string(),
        serviceName: z.string(),
        ...replyFields,
        createdAt: z.string(),
      }),
    ),
    nextBefore: z.string().nullable().describe('Pass as `before` for the next page'),
  }),
);
export type PublicReviewsResponse = z.infer<typeof publicReviewsSchema>;

/** The cabinet: as on the salon page plus the client's name and the visit. */
export const salonReviewsSchema = responseSchema(
  'SalonReviews',
  z.strictObject({
    enabled: z.boolean(),
    ...ratingSummary,
    stars,
    items: z.array(
      z.strictObject({
        id: z.string(),
        rating: z.number().int(),
        text: z.string().nullable(),
        staffId: z.string(),
        staffName: z.string(),
        serviceName: z.string(),
        appointmentId: z.string(),
        visitStartAt: z.string(),
        customerId: z.string().nullable(),
        customerName: z.string().nullable().describe('null after the client was anonymised'),
        ...replyFields,
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
    nextBefore: z.string().nullable(),
  }),
);
export type SalonReviewsResponse = z.infer<typeof salonReviewsSchema>;

/** The client's own review of a visit, and whether they may (still) write or change it. */
export const visitReviewSchema = responseSchema(
  'VisitReview',
  z.strictObject({
    canReview: z
      .boolean()
      .describe(
        'The salon collects reviews, the visit took place and it ended less than 30 days ago',
      ),
    reviewUntil: z.string().nullable().describe('Until when the review can be written or changed'),
    review: z
      .strictObject({
        rating: z.number().int(),
        text: z.string().nullable(),
        ...replyFields,
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .nullable(),
  }),
);
export type VisitReviewResponse = z.infer<typeof visitReviewSchema>;

/** Task 211: one review in the cabinet after the salon answered (or removed the answer). */
export const salonReviewSchema = responseSchema(
  'SalonReview',
  salonReviewsSchema.shape.items.element,
);
export type SalonReviewResponse = z.infer<typeof salonReviewSchema>;
