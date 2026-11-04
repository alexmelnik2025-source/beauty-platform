import { z } from 'zod';
import {
  appointmentSourceSchema,
  appointmentStatusSchema,
  cancelledBySchema,
  localeSchema,
} from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

/** What the salon sees in the calendar, appointment cards, client cards and time blocks. */

export const appointmentSchema = responseSchema(
  'Appointment',
  z.strictObject({
    id: z.string(),
    locationId: z.string(),
    status: appointmentStatusSchema,
    source: appointmentSourceSchema.describe(
      'online = booked by the client, manual = by the salon',
    ),
    start: z.string(),
    end: z.string(),
    blockedUntil: z.string().describe('end plus the cleanup time of the service'),
    date: z.string().describe('Location-local date, YYYY-MM-DD'),
    time: z.string().describe('Location-local start time, HH:MM'),
    staff: z.strictObject({ id: z.string(), displayName: z.string() }),
    service: z.strictObject({ id: z.string(), name: z.string() }),
    customer: z
      .strictObject({
        id: z.string(),
        name: z.string(),
        phone: z.string().nullable().describe('null when the caller may not see client contacts'),
        email: z.string().nullable().describe('null when the caller may not see client contacts'),
      })
      .nullable(),
    priceGrosze: z
      .number()
      .int()
      .nullable()
      .describe('Hundredths of the location currency; null when a staff member may not see prices'),
    staffChosenByClient: z
      .boolean()
      .describe('The client chose this staff member themselves (not "any staff member")'),
    firstVisit: z.boolean().describe('No completed visit of this client before this appointment'),
    durationMinutes: z.number().int(),
    bufferMinutes: z.number().int(),
    note: z.string().nullable(),
    holdExpiresAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    cancelledBy: cancelledBySchema.nullable(),
    cancelReason: z.string().nullable(),
    paidAt: z
      .string()
      .nullable()
      .describe('When the staff marked the visit as paid (this earns loyalty stamps or points)'),
    version: z.number().int(),
    createdAt: z.string(),
  }),
);
export type AppointmentResponse = z.infer<typeof appointmentSchema>;

export const appointmentListSchema = responseSchema('AppointmentList', z.array(appointmentSchema));

export const appointmentDetailSchema = responseSchema(
  'AppointmentDetail',
  appointmentSchema.extend({
    history: z.array(
      z.strictObject({
        type: z.string(),
        actor: z.string(),
        at: z.string(),
        data: z.unknown(),
      }),
    ),
  }),
);
export type AppointmentDetailResponse = z.infer<typeof appointmentDetailSchema>;

export const customerSchema = responseSchema(
  'Customer',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    phone: z.string().nullable().describe('null when the caller may not see client contacts'),
    email: z.string().nullable().describe('null when the caller may not see client contacts'),
    locale: localeSchema,
    note: z.string().nullable().describe('null when the caller may not see notes and tags'),
    tags: z.array(z.string()).nullable(),
    version: z.number().int(),
    createdAt: z.string(),
  }),
);
export type CustomerResponse = z.infer<typeof customerSchema>;

export const customerListSchema = responseSchema('CustomerList', z.array(customerSchema));

export const customerDetailSchema = responseSchema(
  'CustomerDetail',
  customerSchema.extend({
    marketingConsent: z.boolean().nullable().describe('null for staff members'),
    visits: z
      .array(
        z.strictObject({
          id: z.string(),
          locationId: z.string(),
          start: z.string(),
          status: appointmentStatusSchema,
          serviceName: z.string(),
          staffName: z.string(),
        }),
      )
      .describe('Staff without viewClientHistory get only their own appointments with this client'),
  }),
);
export type CustomerDetailResponse = z.infer<typeof customerDetailSchema>;

export const timeBlockSchema = responseSchema(
  'TimeBlock',
  z.strictObject({
    id: z.string(),
    locationId: z.string(),
    staffId: z.string().nullable().describe('null = the whole location'),
    start: z.string(),
    end: z.string(),
    date: z.string().describe('Location-local start date, YYYY-MM-DD'),
    time: z.string().describe('Location-local start time, HH:MM'),
    reason: z.string().nullable(),
    version: z.number().int(),
    deleted: z.boolean(),
    updatedAt: z.string(),
  }),
);
export type TimeBlockResponse = z.infer<typeof timeBlockSchema>;

export const timeBlockListSchema = responseSchema('TimeBlockList', z.array(timeBlockSchema));

const calendarStaffSchema = z.strictObject({
  id: z.string(),
  displayName: z.string(),
  days: z
    .array(
      z.strictObject({
        date: z.string(),
        intervals: z.array(z.strictObject({ start: z.string(), end: z.string() })),
      }),
    )
    .describe('Working hours per local date (special days already applied). Empty = day off'),
});
export type CalendarStaff = z.infer<typeof calendarStaffSchema>;

export const calendarSchema = responseSchema(
  'Calendar',
  z.strictObject({
    location: z.strictObject({
      id: z.string(),
      name: z.string(),
      timezone: z.string(),
      currency: z.string().describe('ISO 4217; prices are in hundredths of it'),
      slotStepMinutes: z.number().int(),
    }),
    from: z.string(),
    to: z.string(),
    staff: z.array(calendarStaffSchema),
    timeOff: z.array(
      z.strictObject({
        id: z.string(),
        staffId: z.string(),
        start: z.string(),
        end: z.string(),
        note: z.string().nullable(),
      }),
    ),
    appointments: z.array(appointmentSchema),
    blocks: z.array(timeBlockSchema),
  }),
);
export type CalendarResponse = z.infer<typeof calendarSchema>;
