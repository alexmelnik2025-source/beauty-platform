import { z } from 'zod';
import { responseSchema } from '../../common/openapi';

/** The ticked rows of a sent file, each with where clients see it. */
export const importFeedSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(64).describe('The row’s id in the file'),
        /** false = "tylko w salonie"; true = "też online w Sklepie". */
        online: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(500)
    .refine((items) => new Set(items.map((i) => i.key)).size === items.length, {
      message: 'each product once',
    }),
});

export type ImportFeedInput = z.infer<typeof importFeedSchema>;

/** Task Q4 (part 3): what was read from the file, with what the platform already has. */
export const feedPreviewSchema = responseSchema(
  'ShopFeedPreview',
  z.strictObject({
    feedId: z.string().describe('Send the ticked rows to …/feed/{feedId}/import within a day'),
    format: z.enum(['google', 'ceneo', 'csv']),
    unreadable: z.number().int().describe('Rows without a name or id, or with an id seen before'),
    products: z.array(
      z.strictObject({
        key: z.string(),
        name: z.string(),
        ean: z.string().nullable(),
        sku: z.string().nullable(),
        brand: z.string().nullable(),
        priceGrosze: z
          .number()
          .int()
          .nullable()
          .describe('null = no price, or a price in another currency than the salon’s'),
        currency: z.string().nullable().describe('As the file says it; null = not said'),
        stock: z.number().int().nullable().describe('null = the file does not say'),
        imageUrl: z.string().nullable(),
        importedProductId: z
          .string()
          .nullable()
          .describe('The salon’s product already made from this row; null = not imported'),
        catalogProductId: z
          .string()
          .nullable()
          .describe('The platform card with the same EAN; null = a new card will be made'),
      }),
    ),
  }),
);

export const feedImportResultSchema = responseSchema(
  'ShopFeedImportResult',
  z.strictObject({
    created: z.number().int(),
    updated: z.number().int(),
    cardsCreated: z.number().int(),
    cardsMatched: z.number().int(),
    photosAdded: z
      .number()
      .int()
      .describe('Cards without a photo that got the picture from the file (image_link / zdjęcie)'),
    skipped: z.array(
      z.strictObject({
        key: z.string(),
        reason: z
          .enum(['NOT_IN_FEED', 'NO_PRICE', 'OTHER_CURRENCY'])
          .describe('Not in the file, no price, or a price in another currency than the salon’s'),
      }),
    ),
  }),
);

export type FeedPreviewResponse = z.infer<typeof feedPreviewSchema>;
export type FeedImportResultResponse = z.infer<typeof feedImportResultSchema>;
