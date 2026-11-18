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
});

export const updateProductSchema = z
  .object({
    name: createProductSchema.shape.name,
    priceGrosze: createProductSchema.shape.priceGrosze,
    stockQuantity: z.number().int().min(0).max(100_000).nullable(),
    lowStockAt: z.number().int().min(0).max(100_000).nullable(),
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

/** Task 436: the language of the stock CSV's columns. */
export const stockCsvQuerySchema = z.object({ locale: z.enum(CSV_LOCALES).default('pl') });

export type StockCsvQuery = z.infer<typeof stockCsvQuerySchema>;
export type RestockProductInput = z.infer<typeof restockProductSchema>;
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

export const STOCK_MOVEMENT_KINDS = ['sale', 'sale_removed', 'delivery', 'correction'] as const;

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
              'sale — sold at a visit; sale_removed — a sale removed, pieces back; delivery — "Dostawa"; correction — the number written by hand',
            ),
          change: z.number().int().describe('Pieces added (+) or taken (−)'),
          quantityAfter: z
            .number()
            .int()
            .nullable()
            .describe('Pieces in stock after the change; null = the salon stopped counting'),
          at: z.iso.datetime(),
          byName: z.string().nullable().describe('Who did it; null when unknown'),
        }),
      )
      .describe('Newest first, at most 100'),
  }),
);

export type StockHistoryResponse = z.infer<typeof stockHistorySchema>;
export type ProductListResponse = z.infer<typeof productListSchema>;
export type ProductResponse = z.infer<typeof productSchema>;
export type VisitProductSalesResponse = z.infer<typeof visitProductSalesSchema>;
