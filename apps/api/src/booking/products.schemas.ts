import { z } from 'zod';
import { responseSchema } from '../common/openapi';

const money = (what: string) =>
  z.number().int().describe(`${what}, in hundredths of the salon currency`);

// ── Requests ─────────────────────────────────────────────

/** Task 394: a product of the salon's list. */
export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(80),
  priceGrosze: z.number().int().min(0).max(10_000_000),
});

export const updateProductSchema = z
  .object({
    name: createProductSchema.shape.name,
    priceGrosze: createProductSchema.shape.priceGrosze,
    active: z.boolean(),
  })
  .partial();

/** Task 394: a product sold at the visit; the price is the product's at this moment. */
export const addProductSaleSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(99).default(1),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AddProductSaleInput = z.infer<typeof addProductSaleSchema>;

// ── Responses ────────────────────────────────────────────

const product = z.strictObject({
  id: z.string(),
  name: z.string(),
  priceGrosze: money('Price of one'),
  active: z.boolean().describe('false = no longer sold; kept for the history of sales'),
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

export type ProductListResponse = z.infer<typeof productListSchema>;
export type ProductResponse = z.infer<typeof productSchema>;
export type VisitProductSalesResponse = z.infer<typeof visitProductSalesSchema>;
