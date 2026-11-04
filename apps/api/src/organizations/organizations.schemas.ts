import { z } from 'zod';
import { LOCALES } from '../auth/auth.schemas';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

/** Languages spoken with clients (be = Belarusian). Separate from interface locales. */
export const LANGUAGES = ['pl', 'uk', 'ru', 'be', 'en'] as const;

/** A list of spoken languages; repeats are dropped, the order is kept. */
export const languagesSchema = z
  .array(z.enum(LANGUAGES))
  .max(20)
  .transform((list) => [...new Set(list)]);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Polish tax id; spaces and dashes are removed. */
  nip: z
    .string()
    .transform((value) => value.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^\d{10}$/, 'must be 10 digits'))
    .optional(),
});

export const updateOrganizationSchema = createOrganizationSchema.partial();

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/, 'use 3–60 latin letters, digits and dashes');

/** A legal text written by the salon (Markdown). Long enough for a full regulamin. */
const legalText = z
  .string()
  .trim()
  .max(50_000)
  .transform((value) => (value === '' ? null : value))
  .nullable();

const locationFields = {
  name: z.string().trim().min(1).max(100),
  slug,
  timezone: z.string().refine((value) => TIMEZONES.has(value), 'unknown time zone'),
  addressLine: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(3).max(12),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'use international format, e.g. +48123456789')
    .nullable(),
  email: z.string().trim().toLowerCase().pipe(z.email()).nullable(),
  defaultLocale: z.enum(LOCALES),
  slotStepMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]),
  minLeadMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
  bookingHorizonDays: z.number().int().min(1).max(365),
  clientCancelDeadlineMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
  onlineBookingEnabled: z.boolean(),
  languages: languagesSchema,
  /** Shown on the booking page; an empty text removes it. */
  description: z
    .string()
    .trim()
    .max(1000)
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  /** Booking terms (regulamin), Markdown; an empty text removes it. */
  bookingTerms: legalText,
  /** Privacy policy, Markdown; an empty text removes it. */
  privacyPolicy: legalText,
};

export const createLocationSchema = z.object({
  ...locationFields,
  slug: locationFields.slug.optional(),
  latitude: locationFields.latitude.optional(),
  longitude: locationFields.longitude.optional(),
  timezone: locationFields.timezone.default('Europe/Warsaw'),
  phone: locationFields.phone.optional(),
  email: locationFields.email.optional(),
  defaultLocale: locationFields.defaultLocale.default('pl'),
  slotStepMinutes: locationFields.slotStepMinutes.default(15),
  minLeadMinutes: locationFields.minLeadMinutes.default(60),
  bookingHorizonDays: locationFields.bookingHorizonDays.default(30),
  clientCancelDeadlineMinutes: locationFields.clientCancelDeadlineMinutes.default(120),
  onlineBookingEnabled: locationFields.onlineBookingEnabled.default(false),
  languages: locationFields.languages.default([]),
  description: locationFields.description.optional(),
  bookingTerms: locationFields.bookingTerms.optional(),
  privacyPolicy: locationFields.privacyPolicy.optional(),
});

export const updateLocationSchema = z
  .object(locationFields)
  .partial()
  .extend({
    /** The version you read; a mismatch means someone else changed the location meanwhile. */
    version: z.number().int().min(1),
  });

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type CreateLocationInput = z.infer<typeof createLocationSchema>;
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
