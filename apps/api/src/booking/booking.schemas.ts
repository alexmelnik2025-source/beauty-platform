import { visitWishesInputSchema } from './visit-wishes';
import { z } from 'zod';
import { LOCALES } from '../auth/auth.schemas';
import { localDateSchema } from '../scheduling/scheduling.schemas';
import { paymentMethodSchema } from '../common/enums.schemas';

/** An instant with an explicit offset, e.g. 2027-01-04T09:00:00.000Z — exactly as the slot list returns it. */
const instant = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));

const token = z.string().min(20).max(200);

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'must be a valid email address' }));

const phone = z
  .string()
  .transform((value) => value.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'use international format, e.g. +48123456789'));

const name = z.string().trim().min(1).max(100);

// ── Public booking ───────────────────────────────────────

export const createHoldSchema = z.object({
  serviceId: z.uuid(),
  /** Omit for "any staff member". */
  staffId: z.uuid().optional(),
  /** Task 70: "any of these" (e.g. the specialists of one price row); ignored with staffId. */
  staffIds: z.array(z.uuid()).min(1).max(50).optional(),
  start: instant,
  /** A previous hold from the same browser, released when a new slot is picked. */
  releaseHoldToken: token.optional(),
});

export const sendCodeSchema = z.object({
  holdToken: token,
  name,
  phone,
  email,
  locale: z.enum(LOCALES).default('pl'),
  /** The booking terms must be accepted; this is not a consent to data processing. */
  acceptTerms: z.literal(true, { message: 'the booking terms must be accepted' }),
  /** Optional, unticked by default. */
  marketingConsent: z.boolean().default(false),
  /**
   * Where the code goes: email (default) or SMS to `phone`. SMS only when the salon page
   * lists it in codeChannels (an SMS gateway is connected); otherwise SMS_UNAVAILABLE.
   */
  codeChannel: z.enum(['email', 'sms']).default('email'),
});

export const confirmSchema = z.object({
  holdToken: token,
  code: z.string().regex(/^\d{6}$/, 'the code has 6 digits'),
  /**
   * Web: also sign in to "My visits" on this device (httpOnly cookie), so the new
   * visit is already in the client app. The code just confirmed the email.
   */
  signIn: z.boolean().default(false),
  /** Task 80: answers from the optional last step; questions the salon does not ask are ignored. */
  wishes: visitWishesInputSchema.optional(),
});

/**
 * Task 180e: a client signed in to "My visits" books without a code - the session already
 * proved the email, which comes from the session (not from the body).
 */
export const signedInConfirmSchema = z.object({
  holdToken: token,
  name,
  phone,
  locale: z.enum(LOCALES).default('pl'),
  acceptTerms: z.literal(true, { message: 'the booking terms must be accepted' }),
  marketingConsent: z.boolean().default(false),
  wishes: visitWishesInputSchema.optional(),
});

export const releaseHoldSchema = z.object({ holdToken: token });

export const clientRescheduleSchema = z.object({
  start: instant,
  /** Omit to keep the current staff member if free, otherwise anyone who is. */
  staffId: z.uuid().optional(),
});

export const clientCancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

// ── Salon side ───────────────────────────────────────────

const multipleOfFiveMinutes = (ms: number) => ms % (5 * 60_000) === 0;

export const listAppointmentsSchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
    staffId: z.uuid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 42, {
    message: 'at most 42 days per request',
    path: ['to'],
  });

const customerInput = z.object({
  name,
  phone,
  email: email.optional(),
  locale: z.enum(LOCALES).default('pl'),
});

export const createAppointmentSchema = z
  .object({
    serviceId: z.uuid(),
    staffId: z.uuid(),
    start: instant.refine(multipleOfFiveMinutes, 'start must be on a 5-minute mark'),
    /** An existing client of the organization, or a new one. */
    customerId: z.uuid().optional(),
    customer: customerInput.optional(),
    note: z.string().trim().max(500).optional(),
    /** Book outside working hours or during time off (never over another booking). */
    allowOutsideHours: z.boolean().default(false),
    /**
     * A visit that already took place (a walk-in entered afterwards): start today or
     * yesterday (salon time) and not in the future; saved straight away as "came".
     */
    alreadyHappened: z.boolean().default(false),
    /** With alreadyHappened: also mark it paid, so loyalty stamps or points are earned. */
    paid: z.boolean().default(false),
    /** Task 227: with paid, how the client paid (optional). */
    paymentMethod: paymentMethodSchema.optional(),
  })
  .refine((v) => Boolean(v.customerId) !== Boolean(v.customer), {
    message: 'give either customerId or customer',
    path: ['customer'],
  })
  .refine((v) => !v.paid || v.alreadyHappened, {
    message: 'paid is only for a visit that already happened',
    path: ['paid'],
  })
  .refine((v) => !v.paymentMethod || v.paid, {
    message: 'paymentMethod is only for a paid visit',
    path: ['paymentMethod'],
  });

export const rescheduleSchema = z.object({
  version: z.number().int().min(1),
  start: instant.refine(multipleOfFiveMinutes, 'start must be on a 5-minute mark'),
  staffId: z.uuid().optional(),
  allowOutsideHours: z.boolean().default(false),
});

export const cancelSchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().min(1).max(300),
});

/** Task 161b: the salon accepts a visit that waits for it (cancellation guard). */
export const approveSchema = z.object({ version: z.number().int().min(1) });

export const setStatusSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['completed', 'no_show']),
});

const tags = z
  .array(z.string().trim().min(1).max(30))
  .max(10)
  .transform((list) => [...new Set(list)]);

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Task 240: day and month only, "MM-DD" ("02-29" allowed); no year is stored. */
const birthday = z
  .string()
  .regex(/^\d{2}-\d{2}$/, 'Expected MM-DD')
  .refine((value) => {
    const [month, day] = value.split('-').map(Number) as [number, number];
    return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
  }, 'No such day');

export const createCustomerSchema = z.object({
  name,
  phone,
  email: email.optional(),
  locale: z.enum(LOCALES).default('pl'),
  note: z.string().trim().max(1000).optional(),
  tags: tags.default([]),
  birthday: birthday.optional(),
  /** Create even if another client already has this phone number. */
  allowDuplicatePhone: z.boolean().default(false),
});

/** Staff members with editClientNotes may send only note and tags. */
export const updateCustomerSchema = z.object({
  version: z.number().int().min(1),
  name: name.optional(),
  phone: phone.optional(),
  email: email.nullable().optional(),
  locale: z.enum(LOCALES).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  tags: tags.optional(),
  birthday: birthday.nullable().optional(),
});

export const listCustomersSchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Task 277: skip this many clients ("Pokaż więcej" asks for the next page). */
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  /**
   * Task 140 — "haven't been for a while": only clients who have come before (a visit that took
   * place) but not in the last N days, and have no visit booked ahead.
   */
  inactiveDays: z.coerce.number().int().min(14).max(730).optional(),
  /** Task 224: only clients with this label (exactly as written in the card). */
  tag: z.string().trim().min(1).max(30).optional(),
  /**
   * Task 240: only clients whose birthday falls today or in the next days — this many days in
   * all (1 = today only), soonest first. Empty without the permission to see client contacts.
   */
  birthdayDays: z.coerce.number().int().min(1).max(31).optional(),
  /**
   * Task 245: only clients whose latest answer about the salon messages is "yes". Empty without
   * the permission to see client contacts.
   */
  marketing: z.enum(['yes']).optional(),
  /**
   * Task 248: only clients whose first visit that took place (in the caller's salons) was in the
   * last N days (7–90), newest first.
   */
  newDays: z.coerce.number().int().min(7).max(90).optional(),
  /**
   * Task 262: only clients past their usual time to come back (latest visit + the median break
   * between their visits, from three visits) with nothing booked ahead, the most recently due first.
   */
  overdue: z.enum(['yes']).optional(),
  /**
   * Task 264: only clients who did not come (no-show) at least once in the last 365 days, the
   * most recent no-show first.
   */
  noShows: z.enum(['yes']).optional(),
  /**
   * Task 270: only clients who came once — visits that took place on one day only, 30–365 days
   * ago — and have nothing booked ahead, the most recent first.
   */
  once: z.enum(['yes']).optional(),
  /**
   * Task 279: the order of the list — by name (A–Z, the default), by the latest visit that took
   * place (the most recent first, clients without one at the end) or by how many visits took
   * place (the most first). Filters with their own order (newcomers, overdue, no-shows, came
   * once, birthdays) keep it. Task 281: `next` — the nearest booked visit first (clients with
   * nothing booked at the end, by name).
   */
  sort: z.enum(['name', 'recent', 'visits', 'next']).default('name'),
});

export type CreateHoldInput = z.infer<typeof createHoldSchema>;
export type SendCodeInput = z.infer<typeof sendCodeSchema>;
export type ConfirmInput = z.infer<typeof confirmSchema>;
export type SignedInConfirmInput = z.infer<typeof signedInConfirmSchema>;
export type ClientRescheduleInput = z.infer<typeof clientRescheduleSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type RescheduleInput = z.infer<typeof rescheduleSchema>;
export type CancelInput = z.infer<typeof cancelSchema>;
export type SetStatusInput = z.infer<typeof setStatusSchema>;
export type ApproveInput = z.infer<typeof approveSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
