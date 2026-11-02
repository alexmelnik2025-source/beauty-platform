import { z } from 'zod';
import { responseSchema } from './openapi';

/**
 * Small responses outside the salon and client areas: the bell in the cabinet, Web Push,
 * salon photos, the email queue for platform administrators and the health check.
 */

/** Notification kinds: appointment events people in the salon are told about. */
export const NOTIFICATION_TYPES = [
  'appointment.booked',
  'appointment.created',
  'appointment.rescheduled',
  'appointment.cancelled',
] as const;

export const notificationDataSchema = z
  .strictObject({
    locationId: z.string(),
    start: z.string(),
    date: z.string().describe('Location-local date, YYYY-MM-DD'),
    time: z.string().describe('Location-local start time, HH:MM'),
    serviceName: z.string(),
    staffName: z.string(),
    customerName: z.string().nullable(),
    by: z.enum(['client', 'salon']).describe('Who made the change'),
  })
  .describe('What to show without another request. Never client contacts');
export type NotificationData = z.infer<typeof notificationDataSchema>;

export const notificationSchema = responseSchema(
  'Notification',
  z.strictObject({
    id: z.string(),
    organizationId: z.string(),
    type: z
      .enum(NOTIFICATION_TYPES)
      .describe('booked = online by a client, created = by the salon, rescheduled, cancelled'),
    appointmentId: z.string().nullable(),
    data: notificationDataSchema,
    read: z.boolean(),
    createdAt: z.string(),
  }),
);
export type NotificationResponse = z.infer<typeof notificationSchema>;

export const notificationListSchema = responseSchema(
  'NotificationList',
  z.array(notificationSchema),
);

export const unreadCountSchema = responseSchema(
  'UnreadCount',
  z.strictObject({ unread: z.number().int() }),
);

export const notificationsMarkedSchema = responseSchema(
  'NotificationsMarked',
  z.strictObject({ updated: z.number().int().describe('How many became read') }),
);

export const pushPublicKeySchema = responseSchema(
  'PushPublicKey',
  z.strictObject({
    publicKey: z.string().nullable().describe('null: push messages are off on this server'),
  }),
);
export type PushPublicKeyResponse = z.infer<typeof pushPublicKeySchema>;

export const photoSchema = responseSchema(
  'Photo',
  z.strictObject({
    id: z.string(),
    url: z.string().describe('Path on this API, the same for every client: /v1/public/photos/<id>'),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    createdAt: z.string(),
  }),
);
export type PhotoResponse = z.infer<typeof photoSchema>;

export const photoListSchema = responseSchema('PhotoList', z.array(photoSchema));

export const outboxStatsSchema = responseSchema(
  'OutboxStats',
  z.strictObject({
    status: z.enum(['ok', 'warning']),
    problems: z
      .array(z.string())
      .describe('failed = some emails were given up on; stuck = a due email waits too long'),
    pending: z.number().int(),
    due: z.number().int(),
    oldestDueSeconds: z.number().int(),
    failed: z.number().int(),
    sentLast24h: z.number().int(),
  }),
);
export type OutboxStats = z.infer<typeof outboxStatsSchema>;

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
export type FailedEmail = z.infer<typeof failedEmailSchema>;

export const failedEmailListSchema = responseSchema('FailedEmailList', z.array(failedEmailSchema));

export const emailsRequeuedSchema = responseSchema(
  'EmailsRequeued',
  z.strictObject({ requeued: z.number().int() }),
);

export const healthSchema = responseSchema(
  'Health',
  z.strictObject({
    status: z.enum(['ok', 'error']),
    checks: z.strictObject({ database: z.enum(['up', 'down']) }),
    time: z.string(),
  }),
);
export type HealthResponse = z.infer<typeof healthSchema>;
