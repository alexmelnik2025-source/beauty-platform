import { z } from 'zod';

export const CANCELLATION_GUARD_ACTIONS = ['approval', 'phone_only', 'prepay'] as const;

export const updateCancellationGuardSchema = z
  .object({
    version: z.number().int().min(0).describe('0 before the first save, then the returned version'),
    enabled: z.boolean(),
    maxChanges: z
      .number()
      .int()
      .min(1)
      .max(50)
      .nullable()
      .describe('N cancellations or reschedules by the client within windowHours; null = rule off'),
    windowHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .describe('X: the period for maxChanges, in hours (e.g. 720 = 30 days)'),
    lateCancelMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 7)
      .nullable()
      .describe('Y: a cancellation less than this many minutes before the visit; null = rule off'),
    maxNoShows: z.number().int().min(1).max(20).nullable().describe('M no-shows; null = rule off'),
    action: z.enum(CANCELLATION_GUARD_ACTIONS),
  })
  .strict()
  .refine(
    (v) =>
      !v.enabled || v.maxChanges !== null || v.lateCancelMinutes !== null || v.maxNoShows !== null,
    { message: 'Turn on at least one rule', path: ['enabled'] },
  );

export type UpdateCancellationGuardInput = z.infer<typeof updateCancellationGuardSchema>;

export const releaseCustomerSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();

export type ReleaseCustomerInput = z.infer<typeof releaseCustomerSchema>;
