import { z } from 'zod';
import { responseSchema } from '../common/openapi';

export const waitlistStatusSchema = z.enum(['waiting', 'notified', 'cancelled']);

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
