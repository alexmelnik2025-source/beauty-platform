import { z } from 'zod';
import { responseSchema } from '../common/openapi';

export const photoSchema = responseSchema(
  'Photo',
  z.strictObject({
    id: z.string(),
    url: z.string(),
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    sizeBytes: z.number().int(),
    createdAt: z.string(),
  }),
);
export const photoListSchema = responseSchema('PhotoList', z.array(photoSchema));
