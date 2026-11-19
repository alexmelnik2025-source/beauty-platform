import { z } from 'zod';
import { responseSchema } from '../common/openapi';
import { CSV_LOCALES } from '../reports/visits-csv';

const money = (what: string) =>
  z.number().int().describe(`${what}, in hundredths of the salon currency`);

// ── Requests ─────────────────────────────────────────────

/** Task 394: a product of the salon's list. */
export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(80),
  priceGrosze: z.number().int().min(0).max(10_000_000),
  /** Task 429: pieces in stock; null (or left out) = the salon does not count them. */
  stockQuantity: z.number().int().min(0).max(100_000).nullable().optional(),
  /** Task 433: "Kończy się" at this many pieces or fewer; null (or left out) = no warning. */
  lowStockAt: z.number().int().min(0).max(100_000).nullable().optional(),
  /** Task 448: "Cena zakupu" — what the salon pays for one; null (or left out) = not written. */
  purchasePriceGrosze: z.number().int().min(0).max(10_000_000).nullable().optional(),
});

export const updateProductSchema = z
  .object({
    name: createProductSchema.shape.name,
    priceGrosze: createProductSchema.shape.priceGrosze,
    stockQuantity: z.number().int().min(0).max(100_000).nullable(),
    lowStockAt: z.number().int().min(0).max(100_000).nullable(),
    purchasePriceGrosze: z.number().int().min(0).max(10_000_000).nullable(),
    active: z.boolean(),
  })
  .partial();

/** Task 394: a product sold at the visit; the price is the product's at this moment. */
export const addProductSaleSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(99).default(1),
});

/** Task 438: "Dostawa" — pieces that arrived from the supplier, added to what is in stock. */
export const restockProductSchema = z.object({
  quantity: z.number().int().min(1).max(100_000),
});

/** Task 443: "Odpis" — pieces used in the salon, damaged or lost, taken from what is in stock. */
export const writeOffProductSchema = z.object({
  quantity: z.number().int().min(1).max(100_000),
  /** Why, in the salon's own words ("zużyte w salonie", "uszkodzone"); shown in "Historia magazynu". */
  note: z.string().trim().max(120).optional(),
});

/** Task 456: "Inwentaryzacja" — the pieces counted on the shelf, for one or many products at once. */
export const stocktakeSchema = z.object({
  counts: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int().min(0).max(100_000),
      }),
    )
    .min(1)
    .max(500)
    .refine((counts) => new Set(counts.map((c) => c.productId)).size === counts.length, {
      message: 'Each product only once',
    }),
});

/** Task 436: the language of the stock CSV's columns. */
export const stockCsvQuerySchema = z.object({ locale: z.enum(CSV_LOCALES).default('pl') });

export type StockCsvQuery = z.infer<typeof stockCsvQuerySchema>;
export type StocktakeInput = z.infer<typeof stocktakeSchema>;
export type RestockProductInput = z.infer<typeof restockProductSchema>;
export type WriteOffProductInput = z.infer<typeof writeOffProductSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AddProductSaleInput = z.infer<typeof addProductSaleSchema>;

// ── Responses ────────────────────────────────────────────

const product = z.strictObject({
  id: z.string(),
  name: z.string(),
  priceGrosze: money('Price of one'),
  active: z.boolean().describe('false = no longer sold; kept for the history of sales'),
  stockQuantity: z
    .number()
    .int()
    .nullable()
    .describe('Pieces in stock (task 429); null = the salon does not count them'),
  lowStockAt: z
    .number()
    .int()
    .nullable()
    .describe('"Kończy się" at this many pieces or fewer (task 433); null = no warning'),
  lowStock: z
    .boolean()
    .describe('The salon counts the pieces and there are lowStockAt or fewer left (task 433)'),
  purchasePriceGrosze: z
    .number()
    .int()
    .nullable()
    .describe(
      '"Cena zakupu" — what the salon pays for one (task 448); null = not written, and always null for a specialist',
    ),
});

export const productListSchema = responseSchema(
  'ProductList',
  z.strictObject({
    products: z.array(product).describe('The salon’s products, sold ones first, then by name'),
  }),
);

export const productSchema = responseSchema('Product', product);

export const visitProductSalesSchema = responseSchema(
  'VisitProductSales',
  z.strictObject({
    sales: z.array(
      z.strictObject({
        id: z.string(),
        productId: z.string().nullable().describe('null when the product was removed later'),
        name: z.string().describe('The name at the time of the sale'),
        quantity: z.number().int(),
        unitPriceGrosze: money('Price of one at the time of the sale'),
        totalGrosze: money('quantity × price'),
      }),
    ),
    totalGrosze: money('All products of the visit; not part of the visit price'),
  }),
);

export const STOCK_MOVEMENT_KINDS = [
  'sale',
  'sale_removed',
  'delivery',
  'correction',
  'write_off',
  'stocktake',
] as const;

export const stockHistorySchema = responseSchema(
  'StockHistory',
  z.strictObject({
    movements: z
      .array(
        z.strictObject({
          id: z.string(),
          kind: z
            .enum(STOCK_MOVEMENT_KINDS)
            .describe(
              'sale — sold at a visit; sale_removed — a sale removed, pieces back; delivery — "Dostawa"; correction — the number written by hand; write_off — "Odpis" (task 443); stocktake — "Inwentaryzacja", the pieces counted on the shelf (task 456)',
            ),
          change: z.number().int().describe('Pieces added (+) or taken (−)'),
          quantityAfter: z
            .number()
            .int()
            .nullable()
            .describe('Pieces in stock after the change; null = the salon stopped counting'),
          at: z.iso.datetime(),
          date: z.string().describe('The day in the salon’s own time, YYYY-MM-DD'),
          time: z.string().describe('The time in the salon’s own time, HH:MM'),
          byName: z.string().nullable().describe('Who did it; null when unknown'),
          note: z.string().nullable().describe('Why — for a write-off (task 443); otherwise null'),
        }),
      )
      .describe('Newest first, at most 100'),
  }),
);

export const stocktakeResultSchema = responseSchema(
  'Stocktake',
  z.strictObject({
    changed: z.number().int().describe('Products whose number in stock changed'),
    missingPieces: z
      .number()
      .int()
      .describe(
        'Pieces fewer on the shelf than the salon had written (only products already counted)',
      ),
    extraPieces: z
      .number()
      .int()
      .describe(
        'Pieces more on the shelf than the salon had written (only products already counted)',
      ),
    products: z.array(product).describe('The salon’s products after the count, as in the list'),
  }),
);

export type StocktakeResponse = z.infer<typeof stocktakeResultSchema>;
export type StockHistoryResponse = z.infer<typeof stockHistorySchema>;
export type ProductListResponse = z.infer<typeof productListSchema>;
export type ProductResponse = z.infer<typeof productSchema>;
export type VisitProductSalesResponse = z.infer<typeof visitProductSalesSchema>;
