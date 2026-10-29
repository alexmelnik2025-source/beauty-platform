import { z } from 'zod';
import { responseSchema } from '../common/openapi';

const notificationDataSchema = z.strictObject({
  locationId: z.string(),
  start: z.string(),
  date: z.string(),
  time: z.string(),
  serviceName: z.string(),
  staffName: z.string(),
  customerName: z.string().nullable(),
  by: z.enum(['client', 'salon']),
});

export const notificationSchema = responseSchema(
  'Notification',
  z.strictObject({
    id: z.string(),
    organizationId: z.string(),
    type: z.enum([
      'appointment.booked',
      'appointment.created',
      'appointment.rescheduled',
      'appointment.cancelled',
    ]),
    appointmentId: z.string().nullable(),
    data: notificationDataSchema,
    read: z.boolean(),
    createdAt: z.string(),
  }),
);
export const notificationListSchema = responseSchema(
  'NotificationList',
  z.array(notificationSchema),
);
export const unreadCountSchema = responseSchema(
  'UnreadCount',
  z.strictObject({ unread: z.number().int() }),
);
export const markedReadSchema = responseSchema(
  'MarkedRead',
  z.strictObject({ updated: z.number().int() }),
);
