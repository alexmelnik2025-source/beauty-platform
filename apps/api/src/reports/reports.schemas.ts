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

/** Task 30: the same period, and the language of the column names and statuses. */
export const visitsCsvQuerySchema = periodChecks(
  z.object({ ...period, locale: z.enum(CSV_LOCALES).default('pl') }),
);

export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type VisitsCsvQuery = z.infer<typeof visitsCsvQuerySchema>;

/** Task 232: the day whose till is looked at. */
export const tillCloseQuerySchema = z.object({ date: localDateSchema });

/** Task 232: the cash counted in the till at the end of the day. */
export const closeTillSchema = z.object({
  date: localDateSchema,
  countedCashGrosze: z.number().int().min(0).max(100_000_000),
  note: z.string().max(500).nullish(),
});

export type TillCloseQuery = z.infer<typeof tillCloseQuerySchema>;
export type CloseTillInput = z.infer<typeof closeTillSchema>;
