import { z } from 'zod';
import { languageSchema, specialtySchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

const interval = z.strictObject({
  /** Local wall-clock time, HH:MM. */
  start: z.string(),
  /** HH:MM; 24:00 = end of day. */
  end: z.string(),
});

export const openingDaySchema = z.strictObject({
  weekday: z.number().int().min(1).max(7).describe('ISO weekday: 1 = Monday … 7 = Sunday'),
  intervals: z
    .array(interval)
    .describe('Merged hours of everyone who takes online bookings; empty = closed'),
});
export type OpeningDay = z.infer<typeof openingDaySchema>;

export const publicLocationSchema = responseSchema(
  'PublicLocation',
  z
    .strictObject({
      slug: z.string(),
      name: z.string(),
      addressLine: z.string(),
      city: z.string(),
      postalCode: z.string(),
      phone: z.string().nullable(),
      timezone: z.string(),
      defaultLocale: z.string(),
      languages: z
        .array(languageSchema)
        .describe('Languages the salon speaks with clients, in the salon’s order'),
      description: z.string().nullable().describe('What the salon writes about itself'),
      openingHours: z
        .array(openingDaySchema)
        .describe('Monday to Sunday, from the team’s regular weekly hours'),
      photos: z
        .array(z.strictObject({ id: z.string(), url: z.string() }))
        .describe('Salon photos, oldest first: links to /v1/public/photos/<id>'),
      codeChannels: z
        .array(z.enum(['email', 'sms']))
        .describe(
          'Where the booking code can be sent: always email; sms when a gateway is connected',
        ),
      categories: z
        .array(z.strictObject({ id: z.string(), name: z.string() }))
        .describe('Price-list groups in display order; services without a category come last'),
      services: z.array(
        z.strictObject({
          id: z.string(),
          categoryId: z.string().nullable(),
          name: z.string(),
          description: z.string().nullable(),
          durationMinutes: z.number().int(),
          priceGrosze: z.number().int(),
        }),
      ),
      staff: z.array(
        z.strictObject({
          id: z.string(),
          displayName: z.string(),
          bio: z.string().nullable(),
          languages: z.array(languageSchema),
          specialties: z.array(specialtySchema).describe('Main one first'),
          customSpecialty: z.string().nullable(),
          serviceIds: z.array(z.string()),
          photoUrl: z.string().nullable().describe('Link to the photo; null when there is none'),
        }),
      ),
    })
    .describe('The public salon page: no buffers, staff accounts or organization details'),
);
export type PublicLocationResponse = z.infer<typeof publicLocationSchema>;

export const publicLegalTextsSchema = responseSchema(
  'PublicLegalTexts',
  z
    .strictObject({
      name: z.string().describe('Salon name'),
      bookingTerms: z
        .string()
        .nullable()
        .describe('Booking terms (regulamin), Markdown; null when the salon has not written them'),
      privacyPolicy: z
        .string()
        .nullable()
        .describe('Privacy policy, Markdown; null when the salon has not written it'),
      updatedAt: z.string().describe('When the salon settings were last saved'),
    })
    .describe('The texts a client accepts when booking, as written by the salon'),
);
export type PublicLegalTextsResponse = z.infer<typeof publicLegalTextsSchema>;

export const slotSchema = responseSchema(
  'Slot',
  z.strictObject({
    start: z.string().describe('Instant, ISO 8601 UTC'),
    date: z.string().describe('Local date at the location, YYYY-MM-DD'),
    time: z.string().describe('Local wall-clock time, HH:MM'),
    staffIds: z.array(z.string()).describe('Staff members free at this time'),
  }),
);

export const availabilitySchema = responseSchema(
  'Availability',
  z.strictObject({
    timezone: z.string(),
    serviceId: z.string(),
    durationMinutes: z.number().int(),
    slots: z.array(slotSchema),
  }),
);
export type AvailabilityResponse = z.infer<typeof availabilitySchema>;
