import { z } from 'zod';
import { localDateSchema } from '../scheduling/scheduling.schemas';
import { CSV_LOCALES } from './visits-csv';

/** Task 14: the period of a salon report, in the salon's own dates (at most 366 days). */
const period = {
  from: localDateSchema,
  to: localDateSchema,
};

const periodChecks = <T extends z.ZodType<{ from: string; to: string }>>(schema: T) =>
  schema
    .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
    .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 366, {
      message: 'at most 366 days per report',
      path: ['to'],
    });

export const reportQuerySchema = periodChecks(z.object(period));

/** Task 22: the same period, and the language of the column names and statuses. */
export const visitsCsvQuerySchema = periodChecks(
  z.object({ ...period, locale: z.enum(CSV_LOCALES).default('pl') }),
);

export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type VisitsCsvQuery = z.infer<typeof visitsCsvQuerySchema>;
