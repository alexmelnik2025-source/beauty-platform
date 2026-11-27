import { z } from 'zod';
import { responseSchema } from '../common/openapi';

/** Task Q3: the categories of the "Sklep" tab's filter (the Prisma enum ShopCategory). */
export const SHOP_CATEGORIES = [
  'hair_care',
  'styling',
  'beard',
  'skin_care',
  'tools',
  'accessories',
  'gifts',
  'other',
] as const;

/** Task Q3: how a client gets the product (the Prisma enum ShopFulfillment). */
export const SHOP_FULFILLMENTS = ['pickup_at_salon', 'shipping'] as const;

const money = (what: string) =>
  z.number().int().describe(`${what}, in hundredths of the salon currency`);

/** The code on the package: EAN-13, EAN-8 or UPC-A — digits only, spaces and dashes dropped. */
const ean = z
  .string()
  .transform((value) => value.replace(/[\s-]+/g, ''))
  .pipe(z.string().regex(/^\d{8}$|^\d{12,14}$/, 'EAN-8, UPC-A, EAN-13 or GTIN-14 digits'));

// ── Requests ─────────────────────────────────────────────

/** Task Q3: a new card in the platform catalogue, made by a salon. */
export const createCatalogProductSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(60).nullable().optional(),
  /** null (or left out) = no code on the package. */
  ean: ean.nullable().optional(),
  description: z.string().trim().min(1).max(2000).nullable().optional(),
  category: z.enum(SHOP_CATEGORIES).default('other'),
});

export const updateCatalogProductSchema = z
  .object({
    name: createCatalogProductSchema.shape.name,
    brand: z.string().trim().min(1).max(60).nullable(),
    ean: ean.nullable(),
    description: z.string().trim().min(1).max(2000).nullable(),
    category: z.enum(SHOP_CATEGORIES),
  })
  .partial();

/** Task Q3: "Wybierz z katalogu" — words of the name or brand, or the code on the package. */
export const catalogSearchSchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Task Q3: the "Sklep" tab's filters. */
export const publicShopQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  category: z.enum(SHOP_CATEGORIES).optional(),
  /** Only the offers of this salon's city (as written on the salon, any letter case). */
  city: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(24),
});

export type CreateCatalogProductInput = z.infer<typeof createCatalogProductSchema>;
export type UpdateCatalogProductInput = z.infer<typeof updateCatalogProductSchema>;
export type CatalogSearchQuery = z.infer<typeof catalogSearchSchema>;
export type PublicShopQuery = z.infer<typeof publicShopQuerySchema>;

// ── Responses ────────────────────────────────────────────

const card = z.strictObject({
  id: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  ean: z.string().nullable().describe('The code on the package, digits only; null = none'),
  description: z.string().nullable(),
  category: z.enum(SHOP_CATEGORIES),
  photoId: z.string().nullable().describe('The picture: /v1/public/photos/<id>; null = none yet'),
});

/** What the salon sees when it searches the catalogue or makes a card. */
export const catalogProductSchema = responseSchema(
  'CatalogProduct',
  card.extend({
    sellers: z.number().int().describe('Salons offering this card (sold ones only)'),
    editable: z
      .boolean()
      .describe('This salon made the card and is the only one offering it, so it may change it'),
    offeredHere: z
      .string()
      .nullable()
      .describe('The id of this salon’s product that already points to the card; null = none'),
  }),
);

export const catalogSearchResultSchema = responseSchema(
  'CatalogSearch',
  z.strictObject({
    products: z.array(catalogProductSchema).describe('Best match first, then by name'),
  }),
);

/** Task Q3: a salon's offer as a client sees it. The stock number itself stays in the salon. */
const publicOffer = z.strictObject({
  productId: z.string().describe('The salon’s product: what the client asks to put aside'),
  priceGrosze: money('Price of one at this salon'),
  currency: z.string().describe('ISO 4217 code of the salon’s currency'),
  available: z
    .boolean()
    .describe('false = the salon counts its pieces and has none left right now'),
  fulfillment: z
    .array(z.enum(SHOP_FULFILLMENTS))
    .describe('How the client gets it; at the launch always ["pickup_at_salon"]'),
  salon: z.strictObject({
    slug: z.string(),
    name: z.string(),
    city: z.string(),
    addressLine: z.string(),
  }),
});

/** Task Q3: "Produkty salonu" on the salon's booking page. */
export const publicSalonProductsSchema = responseSchema(
  'PublicSalonProducts',
  z.strictObject({
    currency: z.string().describe('ISO 4217 code of the salon’s currency'),
    fulfillment: z
      .array(z.enum(SHOP_FULFILLMENTS))
      .describe('How a client gets a product here; at the launch always ["pickup_at_salon"]'),
    products: z
      .array(
        z.strictObject({
          id: z.string().describe('The salon’s product'),
          name: z.string(),
          brand: z.string().nullable(),
          priceGrosze: money('Price of one'),
          available: z
            .boolean()
            .describe('false = the salon counts its pieces and has none left right now'),
          catalogProductId: z
            .string()
            .nullable()
            .describe('Its card in the platform catalogue; null = the salon’s own product'),
          category: z.enum(SHOP_CATEGORIES).nullable(),
          description: z.string().nullable(),
          photoId: z.string().nullable().describe('/v1/public/photos/<id>; null = none'),
        }),
      )
      .describe('Available ones first, then by name'),
  }),
);

/** Task Q3: one card of the "Sklep" tab with every salon offering it. */
export const publicShopProductSchema = responseSchema(
  'PublicShopProduct',
  card.extend({
    fromPriceGrosze: money('The lowest price among the available offers'),
    offers: z.array(publicOffer).describe('Cheapest first; available ones first'),
  }),
);

export const publicShopListSchema = responseSchema(
  'PublicShopList',
  z.strictObject({
    products: z.array(publicShopProductSchema),
    total: z.number().int().describe('Cards matching the filters, all pages'),
    page: z.number().int(),
    pageSize: z.number().int(),
  }),
);

export type CatalogProductResponse = z.infer<typeof catalogProductSchema>;
export type CatalogSearchResponse = z.infer<typeof catalogSearchResultSchema>;
export type PublicSalonProductsResponse = z.infer<typeof publicSalonProductsSchema>;
export type PublicShopProductResponse = z.infer<typeof publicShopProductSchema>;
export type PublicShopListResponse = z.infer<typeof publicShopListSchema>;

// ── Task Q3 (part 4): products put aside for a visit ─────

export const RESERVATION_STATUSES = ['reserved', 'handed', 'cancelled', 'expired'] as const;

/** "Odbiorę przy wizycie": the client puts a product of the salon aside for this visit. */
export const reserveProductSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(10).default(1),
});
export type ReserveProductInput = z.infer<typeof reserveProductSchema>;

const reservation = z.strictObject({
  id: z.string(),
  productId: z
    .string()
    .nullable()
    .describe('null when the product was removed from the list later'),
  name: z.string().describe('The name at the time it was put aside'),
  quantity: z.number().int(),
  unitPriceGrosze: money('Price of one at the time it was put aside'),
  totalGrosze: money('quantity × price'),
  status: z
    .enum(RESERVATION_STATUSES)
    .describe(
      'reserved — waiting at the salon; handed — given and paid at the visit; cancelled; expired — not picked up in time',
    ),
  photoId: z
    .string()
    .nullable()
    .describe('The card’s picture, /v1/public/photos/<id>; null = none'),
  createdAt: z.iso.datetime(),
});

/** What the client sees by the visit link and in "Moje wizyty": put aside, and what else they may add. */
export const visitProductsSchema = responseSchema(
  'VisitProducts',
  z.strictObject({
    currency: z.string(),
    canChange: z
      .boolean()
      .describe('The visit is still ahead and confirmed: products may be added or taken back'),
    reservations: z.array(reservation).describe('Oldest first; cancelled ones left out'),
    totalGrosze: money('All products still reserved or handed; paid at the salon, not online'),
    available: z
      .array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          brand: z.string().nullable(),
          priceGrosze: money('Price of one'),
          photoId: z.string().nullable(),
          available: z.boolean().describe('false = none left to put aside right now'),
        }),
      )
      .describe('"Produkty salonu" the client may still add (only while canChange)'),
  }),
);
export type VisitProductsResponse = z.infer<typeof visitProductsSchema>;

/** Task Q3 (screen C): after the visit — what the specialist used, put aside for the next one. */
export const usedProductsSchema = responseSchema(
  'UsedProducts',
  z.strictObject({
    currency: z.string(),
    products: z
      .array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          brand: z.string().nullable(),
          priceGrosze: money('Price of one now'),
          photoId: z.string().nullable(),
          available: z.boolean().describe('false = none left to put aside right now'),
          pickupStatus: z.enum(['reserved', 'handed']).optional(),
          reservedForNext: z
            .boolean()
            .describe('Already waiting for the client on their next visit'),
        }),
      )
      .describe(
        'Products the specialist marked as used at this visit; empty before the visit took place',
      ),
    nextVisit: z
      .strictObject({
        date: z.string().describe('YYYY-MM-DD in the salon’s time'),
        time: z.string().describe('HH:mm in the salon’s time'),
        staffName: z.string(),
      })
      .nullable()
      .describe('The client’s next confirmed visit in this salon; null = none booked'),
    rebook: z
      .strictObject({ serviceId: z.string(), staffId: z.string() })
      .describe('"Umów kolejną wizytę": the same service with the same specialist'),
  }),
);
export type UsedProductsResponse = z.infer<typeof usedProductsSchema>;

/** What the salon sees in the visit card: "Do wydania klientowi". */
export const visitReservationsSchema = responseSchema(
  'VisitReservations',
  z.strictObject({
    reservations: z.array(reservation).describe('Oldest first, every status'),
    toHandGrosze: money('Products still waiting to be handed over'),
  }),
);
export type VisitReservationsResponse = z.infer<typeof visitReservationsSchema>;
