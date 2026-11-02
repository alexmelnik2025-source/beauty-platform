import { z } from 'zod';
import type { LoyaltyTransactionType } from '../generated/prisma/client';
import { responseSchema } from '../common/openapi';
import { loyaltyModeSchema } from './loyalty.schemas';

export const loyaltyTransactionTypeSchema = z.enum([
  'earn',
  'reverse',
  'redeem',
  'adjust',
  'expire',
] satisfies LoyaltyTransactionType[]);

export const loyaltyProgramSchema = responseSchema(
  'LoyaltyProgram',
  z.strictObject({
    enabled: z.boolean(),
    mode: loyaltyModeSchema.describe(
      'stamps = cyclic stamp card, points = points balance exchanged for rewards',
    ),
    stampsPerVisit: z.number().int().describe('stamps mode: stamps for one paid visit'),
    pointsPerUnit: z
      .number()
      .int()
      .describe('points mode: points for every full spendUnitGrosze of the visit price'),
    spendUnitGrosze: z.number().int().describe('1 PLN = 100'),
    minSpendGrosze: z.number().int().describe('Cheaper visits earn nothing'),
    pointsValidityDays: z.number().int().nullable().describe('null = points never expire'),
    maxDiscountPercent: z.number().int(),
    allowStacking: z.boolean().describe('Several discounts on one visit'),
    marketplaceEnabled: z.boolean().describe('Only a flag until the marketplace exists'),
    earnRules: z
      .array(
        z.strictObject({
          serviceId: z.string(),
          serviceName: z.string(),
          locationId: z.string(),
          points: z.number().int().describe('Instead of the general rule; 0 = earns nothing'),
        }),
      )
      .describe('Only services of the locations the caller can see'),
    version: z.number().int().describe('0 = never saved, these are the defaults'),
  }),
);
export type LoyaltyProgramResponse = z.infer<typeof loyaltyProgramSchema>;

export const loyaltyTransactionSchema = responseSchema(
  'LoyaltyTransaction',
  z.strictObject({
    id: z.string(),
    customer: z.strictObject({ id: z.string(), name: z.string() }),
    type: loyaltyTransactionTypeSchema,
    points: z.number().int().describe('Signed: + earned, − taken back or spent'),
    balanceAfter: z.number().int(),
    appointmentId: z.string().nullable(),
    reversesId: z.string().nullable().describe('reverse: the entry it takes back'),
    expiresAt: z.string().nullable(),
    actorUserId: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
  }),
);
export type LoyaltyTransactionResponse = z.infer<typeof loyaltyTransactionSchema>;

export const loyaltyTransactionListSchema = responseSchema(
  'LoyaltyTransactionList',
  z.array(loyaltyTransactionSchema),
);

export const loyaltyAccountSchema = responseSchema(
  'LoyaltyAccount',
  z.strictObject({
    customer: z.strictObject({ id: z.string(), name: z.string() }),
    mode: loyaltyModeSchema,
    balance: z.number().int().describe('Stamps of the current cycle or points'),
    lifetimeEarned: z.number().int(),
    transactions: z.array(loyaltyTransactionSchema).describe('Newest first, at most 100'),
  }),
);
export type LoyaltyAccountResponse = z.infer<typeof loyaltyAccountSchema>;
