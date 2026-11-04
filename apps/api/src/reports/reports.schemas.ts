import { z } from 'zod';
import { localDateSchema } from '../scheduling/scheduling.schemas';

/** Task 14: the period of a salon report, in the salon's own dates. */
export const reportQuerySchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 366, {
    message: 'at most 366 days per report',
    path: ['to'],
  });

export type ReportQuery = z.infer<typeof reportQuerySchema>;
