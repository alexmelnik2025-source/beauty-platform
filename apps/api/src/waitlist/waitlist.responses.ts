import { z } from 'zod';
import { responseSchema } from '../common/openapi';

export const waitlistStatusSchema = z
  .enum(['waiting', 'notified', 'cancelled', 'offered', 'booked', 'declined', 'missed'])
  .describe(
    'notified: told about free times (before task 164); offered: a time is held for the client ' +
      'for 15 minutes; booked: the client took it; declined: said no; missed: did not answer in time',
  );

export const waitlistJoinedSchema = responseSchema(
  'WaitlistJoined',
  z.strictObject({
    date: z.string().describe('YYYY-MM-DD in the salon time zone'),
    status: waitlistStatusSchema,
    alreadyWaiting: z.boolean().describe('The same email was already waiting for this'),
  }),
);
export type WaitlistJoinedResponse = z.infer<typeof waitlistJoinedSchema>;

/** What the client's link shows. Never other clients or the salon's notes. */
export const publicWaitlistEntrySchema = responseSchema(
  'PublicWaitlistEntry',
  z.strictObject({
    salon: z.strictObject({ name: z.string(), slug: z.string() }),
    serviceId: z.string(),
    serviceName: z.string(),
    staffId: z.string().nullable(),
    staffName: z.string().nullable().describe('null = any specialist'),
    date: z.string(),
    status: waitlistStatusSchema,
  }),
);
export type PublicWaitlistEntryResponse = z.infer<typeof publicWaitlistEntrySchema>;

/** Task 50c: the salon's waiting list for owners and managers (names and contacts included). */
export const salonWaitlistEntrySchema = responseSchema(
  'SalonWaitlistEntry',
  z.strictObject({
    id: z.string(),
    date: z.string().describe('YYYY-MM-DD in the salon time zone'),
    serviceId: z.string(),
    serviceName: z.string(),
    staffId: z.string().nullable(),
    staffName: z.string().nullable().describe('null = any specialist'),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    status: waitlistStatusSchema,
    createdAt: z.string(),
    notifiedAt: z.string().nullable().describe('When the client was told a time became free'),
  }),
);
export type SalonWaitlistEntryResponse = z.infer<typeof salonWaitlistEntrySchema>;

export const salonWaitlistSchema = responseSchema(
  'SalonWaitlist',
  z.strictObject({
    from: z.string().describe('The first day listed (YYYY-MM-DD)'),
    items: z.array(salonWaitlistEntrySchema),
  }),
);
export type SalonWaitlistResponse = z.infer<typeof salonWaitlistSchema>;

/** Task 51: the signed-in client's own waiting lists in the app (no other clients, no contacts). */
export const clientWaitlistEntrySchema = responseSchema(
  'ClientWaitlistEntry',
  z.strictObject({
    id: z.string(),
    salon: z.strictObject({ name: z.string(), slug: z.string(), timezone: z.string() }),
    serviceId: z.string(),
    serviceName: z.string(),
    staffId: z.string().nullable(),
    staffName: z.string().nullable().describe('null = any specialist'),
    date: z.string().describe('YYYY-MM-DD in the salon time zone'),
    status: waitlistStatusSchema,
    notifiedAt: z.string().nullable().describe('When the client was told a time became free'),
    createdAt: z.string(),
  }),
);
export type ClientWaitlistEntryResponse = z.infer<typeof clientWaitlistEntrySchema>;

export const clientWaitlistSchema = responseSchema(
  'ClientWaitlist',
  z.strictObject({ items: z.array(clientWaitlistEntrySchema) }),
);
export type ClientWaitlistResponse = z.infer<typeof clientWaitlistSchema>;

/** Task 164: the offer behind the link in the email — the held time, until when, the answer. */
export const waitlistOfferSchema = responseSchema(
  'WaitlistOffer',
  z.strictObject({
    salon: z.strictObject({ name: z.string(), slug: z.string() }),
    serviceId: z.string(),
    serviceName: z.string(),
    staffName: z.string().nullable().describe('The specialist of the held time'),
    date: z.string().describe('YYYY-MM-DD in the salon time zone'),
    time: z.string().nullable().describe('HH:MM in the salon time zone'),
    durationMinutes: z.number().int().nullable(),
    priceGrosze: z.number().int().nullable().describe('Price in hundredths of the salon currency'),
    currency: z.string(),
    status: waitlistStatusSchema,
    expiresAt: z.string().nullable().describe('Until when the time is held'),
    needsPhone: z.boolean().describe('The list has no phone: give one to take the time'),
  }),
);
export type WaitlistOfferResponse = z.infer<typeof waitlistOfferSchema>;
