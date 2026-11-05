import { z } from 'zod';
import { responseSchema } from '../common/openapi';
import { CANCELLATION_GUARD_ACTIONS } from './cancellation-guard.schemas';

export const GUARD_REASONS = ['changes', 'late_cancel', 'no_shows'] as const;

export const cancellationGuardSchema = responseSchema(
  'CancellationGuard',
  z.strictObject({
    enabled: z.boolean(),
    maxChanges: z.number().int().nullable(),
    windowHours: z.number().int(),
    lateCancelMinutes: z.number().int().nullable(),
    maxNoShows: z.number().int().nullable(),
    action: z.enum(CANCELLATION_GUARD_ACTIONS),
    version: z.number().int().describe('0 = never saved (defaults)'),
  }),
);
export type CancellationGuardResponse = z.infer<typeof cancellationGuardSchema>;

const counters = {
  changes: z
    .number()
    .int()
    .describe('Cancellations and reschedules by the client within the window, since the last lift'),
  lateCancellations: z
    .number()
    .int()
    .describe('Late cancellations by the client since the last lift'),
  noShows: z.number().int().describe('No-shows since the last lift'),
  noShowAmountGrosze: z
    .number()
    .int()
    .describe('What the missed visits cost (price after discounts), in hundredths of the currency'),
  releasedAt: z.string().nullable().describe('When the salon last lifted the mark'),
};

export const guardedClientsSchema = responseSchema(
  'GuardedClients',
  z.strictObject({
    enabled: z.boolean(),
    action: z.enum(CANCELLATION_GUARD_ACTIONS),
    currency: z.string(),
    items: z.array(
      z.strictObject({
        customerId: z.string(),
        name: z.string(),
        phone: z.string(),
        email: z.string().nullable(),
        reasons: z.array(z.enum(GUARD_REASONS)),
        ...counters,
      }),
    ),
  }),
);
export type GuardedClientsResponse = z.infer<typeof guardedClientsSchema>;

export const guardedClientSchema = responseSchema(
  'GuardedClient',
  z.strictObject({
    customerId: z.string(),
    enabled: z.boolean(),
    action: z.enum(CANCELLATION_GUARD_ACTIONS),
    currency: z.string(),
    flagged: z.boolean().describe('The guard is on and a rule marks the client now'),
    reasons: z.array(z.enum(GUARD_REASONS)),
    ...counters,
    history: z
      .array(
        z.strictObject({
          type: z.enum(['cancelled', 'rescheduled', 'no_show', 'released']),
          at: z.string().describe('When it happened (for a no-show: the visit start)'),
          visitStart: z.string().nullable(),
          late: z.boolean().describe('A cancellation later than the late-cancellation rule allows'),
          appointmentId: z.string().nullable(),
          note: z.string().nullable().describe('The salon’s note when lifting the mark'),
        }),
      )
      .describe('Newest first, the last 365 days, at most 50'),
  }),
);
export type GuardedClientResponse = z.infer<typeof guardedClientSchema>;
