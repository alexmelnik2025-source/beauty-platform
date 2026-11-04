import { z } from 'zod';
import { responseSchema } from '../common/openapi';

/** Task 80b: a client's example photo; `url` is a signed link that works for an hour. */
export const visitPhotoSchema = responseSchema(
  'VisitPhoto',
  z.strictObject({
    id: z.string(),
    url: z.string().describe('Signed link to the picture, valid for an hour (for <img>)'),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    createdAt: z.string(),
  }),
);
export type VisitPhotoResponse = z.infer<typeof visitPhotoSchema>;

export const visitPhotoListSchema = responseSchema(
  'VisitPhotoList',
  z.strictObject({
    items: z.array(visitPhotoSchema),
    deleteAfter: z
      .string()
      .nullable()
      .describe('When the photos are deleted (90 days after the visit); null for a hold'),
  }),
);
export type VisitPhotoListResponse = z.infer<typeof visitPhotoListSchema>;
