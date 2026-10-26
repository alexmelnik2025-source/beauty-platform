import { z } from 'zod';
import { LOCALES } from '../auth/auth.schemas';
import { localDateSchema } from '../scheduling/scheduling.schemas';

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
});

export const confirmSchema = z.object({
  holdToken: token,
  code: z.string().regex(/^\d{6}$/, 'the code has 6 digits'),
  /**
   * Web: also sign in to "My visits" on this device (httpOnly cookie), so the new
   * visit is already in the client app. The code just confirmed the email.
   */
  signIn: z.boolean().default(false),
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
  })
  .refine((v) => Boolean(v.customerId) !== Boolean(v.customer), {
    message: 'give either customerId or customer',
    path: ['customer'],
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

export const setStatusSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['completed', 'no_show']),
});

const tags = z
  .array(z.string().trim().min(1).max(30))
  .max(10)
  .transform((list) => [...new Set(list)]);

export const createCustomerSchema = z.object({
  name,
  phone,
  email: email.optional(),
  locale: z.enum(LOCALES).default('pl'),
  note: z.string().trim().max(1000).optional(),
  tags: tags.default([]),
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
});

export const listCustomersSchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateHoldInput = z.infer<typeof createHoldSchema>;
export type SendCodeInput = z.infer<typeof sendCodeSchema>;
export type ConfirmInput = z.infer<typeof confirmSchema>;
export type ClientRescheduleInput = z.infer<typeof clientRescheduleSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type RescheduleInput = z.infer<typeof rescheduleSchema>;
export type CancelInput = z.infer<typeof cancelSchema>;
export type SetStatusInput = z.infer<typeof setStatusSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
