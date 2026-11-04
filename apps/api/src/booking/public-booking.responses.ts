import { visitWishesSchema, wishQuestionsSchema } from './visit-wishes';
import { z } from 'zod';
import { appointmentStatusSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

export const holdSchema = responseSchema(
  'Hold',
  z
    .strictObject({
      holdId: z.string(),
      holdToken: z
        .string()
        .describe('Proves this browser made the hold; send it with the next steps'),
      expiresAt: z.string(),
      start: z.string(),
      end: z.string(),
      date: z.string(),
      time: z.string(),
      staffId: z.string(),
      staffName: z.string(),
      serviceName: z.string(),
      priceGrosze: z.number().int().describe('What the visit costs (after a happy-hour discount)'),
      listPriceGrosze: z
        .number()
        .int()
        .nullable()
        .describe("The service price before the salon's happy-hour discount; null = no discount"),
      happyHourPercent: z.number().int().nullable().describe('Task 16: the happy-hour discount'),
      currency: z.string().describe('ISO 4217; prices are in hundredths of it'),
    })
    .describe('A slot kept for the client for 10 minutes'),
);
export type HoldResponse = z.infer<typeof holdSchema>;

export const codeSentSchema = responseSchema(
  'CodeSent',
  z.strictObject({
    codeExpiresAt: z.string(),
    channel: z.enum(['email', 'sms']),
  }),
);
export type CodeSentResponse = z.infer<typeof codeSentSchema>;

export const publicAppointmentSchema = responseSchema(
  'PublicAppointment',
  z
    .strictObject({
      id: z.string(),
      status: appointmentStatusSchema,
      start: z.string(),
      end: z.string(),
      date: z.string().describe('Location-local date, YYYY-MM-DD'),
      time: z.string().describe('Location-local time, HH:MM'),
      timezone: z.string(),
      currency: z.string().describe('ISO 4217; prices are in hundredths of it'),
      service: z.strictObject({
        id: z.string(),
        name: z.string(),
        durationMinutes: z.number().int(),
        priceGrosze: z.number().int(),
      }),
      staff: z.strictObject({ id: z.string(), displayName: z.string() }),
      salon: z.strictObject({
        name: z.string(),
        slug: z.string(),
        addressLine: z.string(),
        city: z.string(),
        postalCode: z.string(),
        phone: z.string().nullable(),
      }),
      changeableUntil: z.string().describe('Until when the client can still move or cancel online'),
      canChange: z.boolean(),
      wishes: visitWishesSchema,
      wishQuestions: wishQuestionsSchema,
      canChangeWishes: z
        .boolean()
        .describe('The wishes can still be changed (confirmed visit that has not started)'),
    })
    .describe('An appointment as the client sees it'),
);
export type PublicAppointmentResponse = z.infer<typeof publicAppointmentSchema>;

export const bookingConfirmedSchema = responseSchema(
  'BookingConfirmed',
  z.strictObject({
    appointment: publicAppointmentSchema,
    manageToken: z.string().describe('For the "manage my appointment" link (also sent by email)'),
    signedIn: z.boolean().describe('True when the client was also signed in to "My visits"'),
  }),
);
export type BookingConfirmedResponse = z.infer<typeof bookingConfirmedSchema>;
