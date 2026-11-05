import { z } from 'zod';
import { LOCALES } from '../auth/auth.schemas';
import { localDateSchema } from '../scheduling/scheduling.schemas';

const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'use international format, e.g. +48123456789'));

/** Task 50: "tell me when a time becomes free" on the booking page. */
export const joinWaitlistSchema = z.object({
  serviceId: z.uuid(),
  /** Omit for "any specialist". */
  staffId: z.uuid().optional(),
  /** The day in the salon's time zone. */
  date: localDateSchema,
  name: z.string().trim().min(1).max(100),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email({ message: 'must be a valid email address' })),
  phone: phoneSchema.optional(),
  locale: z.enum(LOCALES).default('pl'),
  /** Like booking: the salon's terms must be accepted (they cover the waiting list too). */
  acceptTerms: z.literal(true, { message: 'the booking terms must be accepted' }),
});
export type JoinWaitlistInput = z.infer<typeof joinWaitlistSchema>;

/** Task 50c: the salon's list from a day on (default: today in the salon's time zone). */
export const salonWaitlistQuerySchema = z
  .object({
    from: localDateSchema.optional(),
  })
  .strict();
export type SalonWaitlistQuery = z.infer<typeof salonWaitlistQuerySchema>;

/** Task 51: joining from the client app — the email is the signed-in client's own. */
export const clientJoinWaitlistSchema = joinWaitlistSchema.omit({ email: true }).strict();
export type ClientJoinWaitlistInput = z.infer<typeof clientJoinWaitlistSchema>;

/** Task 164: taking the held time from the offer email; a phone when the list had none. */
export const acceptWaitlistOfferSchema = z
  .object({
    phone: phoneSchema.optional(),
  })
  .strict();
export type AcceptWaitlistOfferInput = z.infer<typeof acceptWaitlistOfferSchema>;
