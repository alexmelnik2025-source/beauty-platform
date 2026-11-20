import { z } from 'zod';
import { responseSchema } from '../../common/openapi';

// ── Requests ─────────────────────────────────────────────

/** Step 1: the seller's API token from Base (Moje konto → API). */
export const connectBaseSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, 'the token from Base → Moje konto → API')
    .max(200)
    .regex(/^[\x21-\x7e]+$/, 'letters, digits and signs only, no spaces'),
});

/** Task Q4 (part 2): how often prices and stock are renewed from Base, minutes. */
export const SYNC_EVERY_MINUTES = [15, 30, 60, 180, 360, 720, 1440] as const;

/** Step 2: which catalogue, price group and warehouse go to the platform. */
export const configureBaseSchema = z.object({
  inventoryId: z.string().trim().min(1).max(32),
  priceGroupId: z.string().trim().min(1).max(32),
  warehouseId: z.string().trim().min(1).max(64),
  /** Left out = unchanged (60 at first). */
  syncEveryMinutes: z
    .number()
    .int()
    .refine((n) => (SYNC_EVERY_MINUTES as readonly number[]).includes(n), {
      message: `one of ${SYNC_EVERY_MINUTES.join(', ')}`,
    })
    .optional(),
});

/** Step 3a: a page of the seller's catalogue to choose from. */
export const baseProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

/** Step 3b: the products the seller ticked, each with where clients see it. */
export const importBaseSchema = z.object({
  items: z
    .array(
      z.object({
        externalId: z
          .string()
          .trim()
          .regex(/^\d{1,18}$/, 'the product id in Base'),
        /** false = "tylko w salonie" (the salon's booking page); true = "też online w Sklepie". */
        online: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((i) => i.externalId)).size === items.length, {
      message: 'each product once',
    }),
});

export type ConnectBaseInput = z.infer<typeof connectBaseSchema>;
export type ConfigureBaseInput = z.infer<typeof configureBaseSchema>;
export type BaseProductsQuery = z.infer<typeof baseProductsQuerySchema>;
export type ImportBaseInput = z.infer<typeof importBaseSchema>;

// ── Responses ────────────────────────────────────────────

/** "Integracje" → Base: what is connected. The token itself never comes back. */
export const baseIntegrationSchema = responseSchema(
  'BaseIntegration',
  z.strictObject({
    connected: z.boolean().describe('false = no token yet (or it was disconnected)'),
    tokenHint: z.string().nullable().describe('The last 4 characters of the connected token'),
    tokenReadable: z
      .boolean()
      .describe('false = the server key changed since: paste the token again'),
    inventoryId: z.string().nullable().describe('null = step 2 not done yet'),
    inventoryName: z.string().nullable(),
    priceGroupId: z.string().nullable(),
    warehouseId: z.string().nullable(),
    lastImportAt: z.string().nullable().describe('ISO time of the last import; null = never'),
    syncEveryMinutes: z
      .number()
      .int()
      .describe('Prices and stock of imported products are renewed this often, minutes'),
    lastSyncAt: z.string().nullable().describe('ISO time the last renewal started; null = never'),
    lastErrorCode: z
      .string()
      .nullable()
      .describe('The last import or renewal failed with this code; null = it went well'),
    importedProducts: z.number().int().describe('Products of the salon that came from Base'),
  }),
);

/** Step 2: what the seller may choose from, as its Base has it. */
export const baseOptionsSchema = responseSchema(
  'BaseOptions',
  z.strictObject({
    inventories: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        priceGroupIds: z.array(z.string()),
        defaultPriceGroupId: z.string().nullable(),
        warehouseIds: z.array(z.string()),
        defaultWarehouseId: z.string().nullable(),
      }),
    ),
    priceGroups: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        currency: z.string(),
        matchesSalon: z.boolean().describe('Same currency as the salon: only these may be chosen'),
      }),
    ),
    warehouses: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  }),
);

/** Step 3a: one page of the seller's catalogue with what the platform already has. */
export const baseProductsSchema = responseSchema(
  'BaseProducts',
  z.strictObject({
    page: z.number().int(),
    hasMore: z.boolean().describe('Base has another page'),
    products: z.array(
      z.strictObject({
        externalId: z.string(),
        name: z.string(),
        ean: z.string().nullable(),
        sku: z.string().nullable(),
        priceGrosze: z
          .number()
          .int()
          .nullable()
          .describe('From the chosen price group; null = no price there (cannot be imported)'),
        stock: z.number().int().nullable().describe('In the chosen warehouse; null = not there'),
        importedProductId: z
          .string()
          .nullable()
          .describe('The salon’s product already made from it; null = not imported'),
        catalogProductId: z
          .string()
          .nullable()
          .describe('The platform card with the same EAN; null = a new card will be made'),
      }),
    ),
  }),
);

export const baseImportResultSchema = responseSchema(
  'BaseImportResult',
  z.strictObject({
    created: z.number().int().describe('New products of the salon'),
    updated: z.number().int().describe('Products already there: price, stock and code renewed'),
    cardsCreated: z.number().int().describe('New cards in the platform catalogue'),
    cardsMatched: z.number().int().describe('Products joined to an existing card by EAN'),
    skipped: z
      .array(
        z.strictObject({
          externalId: z.string(),
          reason: z
            .enum(['NOT_IN_BASE', 'NO_PRICE', 'NO_NAME'])
            .describe('Not in the chosen catalogue, no price in the group, or no name'),
        }),
      )
      .describe('Products that were not imported, and why'),
  }),
);

const syncRun = z.strictObject({
  id: z.string(),
  trigger: z
    .enum(['import', 'manual', 'schedule'])
    .describe('"Importuj zaznaczone", "Synchronizuj teraz" or the regular renewal'),
  startedAt: z.string(),
  finishedAt: z.string().nullable().describe('null = still running'),
  checked: z.number().int().describe('Products looked at'),
  changed: z
    .number()
    .int()
    .describe('Products whose price or stock changed (import: made or renewed)'),
  missing: z
    .number()
    .int()
    .describe('Imported products no longer in the chosen catalogue: their stock is now 0'),
  errorCode: z
    .string()
    .nullable()
    .describe(
      'null = went well; BASE_TOKEN_INVALID, BASE_RECONNECT, BASE_ERROR, BASE_UNREACHABLE, …',
    ),
  errorMessage: z.string().nullable(),
});

/** Task Q4 (part 2): one import or renewal. */
export const baseSyncRunSchema = responseSchema('BaseSyncRun', syncRun);

/** Task Q4 (part 2): "Dziennik synchronizacji" — the latest runs, newest first. */
export const baseSyncRunsSchema = responseSchema(
  'BaseSyncRuns',
  z.strictObject({ runs: z.array(baseSyncRunSchema).describe('At most 20, newest first') }),
);

export type BaseSyncRunResponse = z.infer<typeof baseSyncRunSchema>;
export type BaseSyncRunsResponse = z.infer<typeof baseSyncRunsSchema>;
export type BaseIntegrationResponse = z.infer<typeof baseIntegrationSchema>;
export type BaseOptionsResponse = z.infer<typeof baseOptionsSchema>;
export type BaseProductsResponse = z.infer<typeof baseProductsSchema>;
export type BaseImportResultResponse = z.infer<typeof baseImportResultSchema>;
