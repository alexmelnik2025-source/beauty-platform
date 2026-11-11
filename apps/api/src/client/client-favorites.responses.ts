import { z } from 'zod';
import { responseSchema } from '../common/openapi';

/** "Favourite salons" in the client app: only public salon data, newest first. */
export const clientFavoritesSchema = responseSchema(
  'ClientFavorites',
  z.strictObject({
    items: z.array(
      z.strictObject({
        slug: z.string(),
        name: z.string(),
        addressLine: z.string(),
        city: z.string(),
        postalCode: z.string(),
        /** false while the salon has online booking switched off: the app shows it greyed out. */
        bookable: z.boolean(),
        addedAt: z.string().datetime(),
        /** Task 367: the salon's time zone — "Otwarte teraz" is counted in it. */
        timezone: z.string(),
        /**
         * Task 367: today's real hours of the salon (special days, vacations, salon-wide blocks),
         * as on its page; empty = closed today, and always empty while it is not `bookable`.
         */
        todayHours: z.array(z.strictObject({ start: z.string(), end: z.string() })),
      }),
    ),
  }),
);

export type ClientFavoritesResponse = z.infer<typeof clientFavoritesSchema>;
