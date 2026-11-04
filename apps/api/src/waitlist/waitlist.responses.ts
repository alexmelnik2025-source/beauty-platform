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
