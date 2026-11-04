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
      }),
    ),
  }),
);

export type ClientFavoritesResponse = z.infer<typeof clientFavoritesSchema>;
