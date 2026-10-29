import { z } from 'zod';
import { responseSchema } from '../common/openapi';

export const outboxStatsSchema = responseSchema(
  'OutboxStats',
  z.strictObject({
    status: z.enum(['ok', 'warning']),
    problems: z.array(z.string()),
    pending: z.number().int(),
    due: z.number().int(),
    oldestDueSeconds: z.number().int(),
    failed: z.number().int(),
    sentLast24h: z.number().int(),
  }),
);
export const failedEmailSchema = responseSchema(
  'FailedEmail',
  z.strictObject({
    id: z.string(),
    type: z.string(),
    appointmentId: z.string().nullable(),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    lastAttemptAt: z.string(),
  }),
);
export const failedEmailListSchema = responseSchema('FailedEmailList', z.array(failedEmailSchema));
export const emailsRequeuedSchema = responseSchema(
  'EmailsRequeued',
  z.strictObject({ requeued: z.number().int() }),
);
