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
    addressLine: z.string(),
    city: z.string(),
    postalCode: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    defaultLocale: localeSchema,
    slotStepMinutes: z.number().int(),
    minLeadMinutes: z.number().int(),
    bookingHorizonDays: z.number().int(),
    clientCancelDeadlineMinutes: z.number().int(),
    onlineBookingEnabled: z.boolean(),
    languages: z
      .array(languageSchema)
      .describe('Languages the salon speaks with clients, in the salon’s order'),
    description: z.string().nullable(),
    version: z.number().int().describe('Send it back when updating (optimistic locking)'),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type LocationResponse = z.infer<typeof locationSchema>;

export const locationListSchema = responseSchema('LocationList', z.array(locationSchema));
