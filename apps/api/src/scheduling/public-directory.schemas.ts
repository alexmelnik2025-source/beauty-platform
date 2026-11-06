import { z } from 'zod';
import { languageSchema, specialtySchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

export const publicDirectoryQuerySchema = z.strictObject({
  /**
   * Task 192: one language or several, comma-separated (`uk,ru,be`): salons where at least one of
   * them is spoken (OR).
   */
  language: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean),
    )
    .pipe(z.array(languageSchema).max(languageSchema.options.length))
    .transform((codes) => [...new Set(codes)])
    .optional(),
  /**
   * Task 180b: "Czego szukasz?" - words in the salon's name, city, street or a service it books
   * online; letters with or without Polish (and Turkish, Albanian) marks match alike.
   */
  q: z.string().trim().max(100).optional(),
  /** Task 160: the kind of place — salons where an active specialist does this. */
  specialty: specialtySchema.optional(),
  /**
   * Task 180b: "W pobliżu" — `latitude,longitude` of the client (the phone or browser asks first);
   * the nearest salons first, with `distanceKm`. Salons without a place on the map come last.
   */
  near: z
    .string()
    .regex(/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/)
    .transform((value) => {
      const [latitude, longitude] = value.split(',').map(Number) as [number, number];
      return { latitude, longitude };
    })
    .pipe(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }),
    )
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

export const publicDirectorySchema = responseSchema(
  'PublicSalonDirectory',
  z.strictObject({
    items: z.array(
      z.strictObject({
        slug: z.string(),
        name: z.string(),
        addressLine: z.string(),
        city: z.string(),
        postalCode: z.string(),
        languages: z.array(languageSchema),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
        /** ISO 4217 code of the salon's prices. */
        currency: z.string(),
        /**
         * Task 91: the lowest price a client can book there ("od 50 zł"), in hundredths of `currency`,
         * counting each specialist's own price; free services are left out. Null when every service is free.
         */
        priceFromGrosze: z.number().int().nullable(),
        /**
         * Task 160: how many active specialists speak the `language` asked for (task 192: at least one
         * of them); null without it.
         */
        staffSpeaking: z.number().int().nullable(),
        /** Task 160: what its active specialists do (the kind of place: barber, nails…). */
        specialties: z.array(specialtySchema),
        /** Task 160: the salon's first photo for the map's card; null without photos. */
        photoUrl: z.string().nullable(),
        /** Task 180b: kilometres from `near` (one decimal); null without `near` or a place on the map. */
        distanceKm: z.number().nullable(),
        /**
         * Task 180b: the stars on the card — average of the salon's reviews (one decimal) and their
         * number; null and 0 while the salon does not collect reviews (165b) or has none yet.
         */
        rating: z.number().nullable(),
        reviewCount: z.number().int(),
      }),
    ),
    /** Task 160: salons per spoken language, with the other filters (the "UA (12)" chips). */
    languageCounts: z.record(languageSchema, z.number().int()),
    /** Task 160: salons per kind of place, with the language filter. */
    specialtyCounts: z.record(specialtySchema, z.number().int()),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    pageCount: z.number().int(),
  }),
);

export type PublicDirectoryQuery = z.infer<typeof publicDirectoryQuerySchema>;
export type PublicDirectoryResponse = z.infer<typeof publicDirectorySchema>;
