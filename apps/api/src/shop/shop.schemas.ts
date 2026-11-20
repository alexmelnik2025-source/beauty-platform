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
