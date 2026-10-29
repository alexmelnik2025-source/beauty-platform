import { z } from 'zod';
import { languageSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

export const publicDirectoryQuerySchema = z.strictObject({
  language: languageSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

export const publicDirectorySchema = responseSchema(
  'PublicSalonDirectory',
  z.strictObject({
    items: z.array(
      z.strictObject({
        slug: z.string(),
        name: z.string(),
        addressLine: z.string(),
        city: z.string(),
        postalCode: z.string(),
        languages: z.array(languageSchema),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
      }),
    ),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    pageCount: z.number().int(),
  }),
);

export type PublicDirectoryQuery = z.infer<typeof publicDirectoryQuerySchema>;
export type PublicDirectoryResponse = z.infer<typeof publicDirectorySchema>;
