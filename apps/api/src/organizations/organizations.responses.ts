import { offeredDrinkSchema } from '../booking/visit-wishes';
import { z } from 'zod';
import { languageSchema, localeSchema, membershipRoleSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

export const organizationSchema = responseSchema(
  'Organization',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    nip: z.string().nullable().describe('Polish tax number'),
    country: z.string(),
    role: membershipRoleSchema.describe('Your role in this organization'),
    createdAt: z.string(),
  }),
);
export type OrganizationResponse = z.infer<typeof organizationSchema>;

export const organizationListSchema = responseSchema(
  'OrganizationList',
  z.array(organizationSchema),
);

export const locationSchema = responseSchema(
  'Location',
  z.strictObject({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    slug: z.string().describe('Public booking link: /b/<slug>'),
    timezone: z.string(),
    currency: z.string().describe('ISO 4217; prices are in hundredths of it'),
    addressLine: z.string(),
    city: z.string(),
    postalCode: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    defaultLocale: localeSchema,
    slotStepMinutes: z.number().int(),
    minLeadMinutes: z.number().int(),
    bookingHorizonDays: z.number().int(),
    clientCancelDeadlineMinutes: z.number().int(),
    onlineBookingEnabled: z.boolean(),
    askMood: z.boolean().describe('Task 80: ask how the client wants to spend the visit'),
    askDrink: z.boolean().describe('Task 80: offer a drink (only the drinks listed)'),
    drinks: z.array(offeredDrinkSchema),
    askNote: z.boolean().describe('Task 80: ask for a short note for the specialist'),
    languages: z
      .array(languageSchema)
      .describe('Languages the salon speaks with clients, in the salon’s order'),
    description: z.string().nullable(),
    bookingTerms: z
      .string()
      .nullable()
      .describe('Booking terms (regulamin), Markdown; needed to switch online booking on'),
    privacyPolicy: z
      .string()
      .nullable()
      .describe('Privacy policy, Markdown; needed to switch online booking on'),
    version: z.number().int().describe('Send it back when updating (optimistic locking)'),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type LocationResponse = z.infer<typeof locationSchema>;

export const locationListSchema = responseSchema('LocationList', z.array(locationSchema));

export const legalTemplatesSchema = responseSchema(
  'LegalTemplates',
  z
    .strictObject({
      bookingTerms: z.string().describe('Booking terms (regulamin), Markdown'),
      privacyPolicy: z.string().describe('Privacy policy, Markdown'),
      missing: z
        .array(z.string())
        .describe('Placeholders like {KRS} still to be filled in by the salon, in order'),
    })
    .describe(
      'Polish templates with the salon’s own details already filled in. A starting point: the salon checks and completes them before saving',
    ),
);
export type LegalTemplatesResponse = z.infer<typeof legalTemplatesSchema>;
