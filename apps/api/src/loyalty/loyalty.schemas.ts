import { z } from 'zod';
import type { LoyaltyMode } from '../generated/prisma/client';

export const loyaltyModeSchema = z.enum(['stamps', 'points'] satisfies LoyaltyMode[]);

/** Upper bounds only protect against typos; the numbers themselves are the salon's choice. */
const amount = z.number().int().min(0).max(100_000);

export const updateLoyaltyProgramSchema = z.object({
  /** 0 = the program was never saved (GET returns version 0 with the defaults). */
  version: z.number().int().min(0),
  enabled: z.boolean(),
  mode: loyaltyModeSchema,
  stampsPerVisit: z.number().int().min(0).max(100),
  pointsPerUnit: amount,
  spendUnitGrosze: z.number().int().min(1).max(10_000_000),
  minSpendGrosze: z.number().int().min(0).max(10_000_000),
  pointsValidityDays: z.number().int().min(1).max(3650).nullable(),
  maxDiscountPercent: z.number().int().min(0).max(100),
  allowStacking: z.boolean(),
  marketplaceEnabled: z.boolean(),
});

export const replaceEarnRulesSchema = z.object({
  rules: z
    .array(z.object({ serviceId: z.uuid(), points: amount }))
    .max(500)
    .refine((rules) => new Set(rules.map((r) => r.serviceId)).size === rules.length, {
      message: 'Each service may appear only once',
    }),
});

export const listLoyaltyTransactionsSchema = z.object({
  customerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const setPaidSchema = z.object({
  version: z.number().int().min(1),
  paid: z.boolean(),
});

export type UpdateLoyaltyProgramInput = z.infer<typeof updateLoyaltyProgramSchema>;
export type ReplaceEarnRulesInput = z.infer<typeof replaceEarnRulesSchema>;
export type ListLoyaltyTransactionsQuery = z.infer<typeof listLoyaltyTransactionsSchema>;
export type SetPaidInput = z.infer<typeof setPaidSchema>;
