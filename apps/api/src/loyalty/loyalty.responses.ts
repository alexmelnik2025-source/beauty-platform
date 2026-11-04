import { z } from 'zod';
import type { LoyaltyTransactionType } from '../generated/prisma/client';
import { responseSchema } from '../common/openapi';
import { loyaltyModeSchema, loyaltyRewardKindSchema } from './loyalty.schemas';

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
    spendUnitGrosze: z.number().int().describe('Hundredths of the location currency: 50.00 = 5000'),
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

export const loyaltyRewardSchema = responseSchema(
  'LoyaltyReward',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    kind: loyaltyRewardKindSchema,
    discountPercent: z.number().int().nullable().describe('discount_percent only'),
    freeServiceId: z.string().nullable().describe('free_service only'),
    cost: z.number().int().describe('Stamps or points'),
    serviceIds: z.array(z.string()).describe('The coupon works only for these; empty = any'),
    couponValidityDays: z.number().int().nullable().describe('null = no limit'),
    sortOrder: z.number().int(),
    archivedAt: z.string().nullable().describe('Removed from the catalogue; coupons stay valid'),
    version: z.number().int(),
  }),
);
export type LoyaltyRewardResponse = z.infer<typeof loyaltyRewardSchema>;

export const loyaltyRewardListSchema = responseSchema(
  'LoyaltyRewardList',
  z.array(loyaltyRewardSchema),
);

export const loyaltyCouponSchema = responseSchema(
  'LoyaltyCoupon',
  z.strictObject({
    id: z.string(),
    code: z.string().describe('Shown by the client at the salon, e.g. "K7QM-4XTB"'),
    rewardId: z.string(),
    name: z.string(),
    kind: loyaltyRewardKindSchema,
    discountPercent: z.number().int().nullable(),
    freeServiceId: z.string().nullable(),
    serviceIds: z.array(z.string()),
    cost: z.number().int().describe('Stamps or points it took'),
    status: z
      .enum(['active', 'used', 'cancelled', 'expired'])
      .describe('expired = active but past expiresAt'),
    expiresAt: z.string().nullable(),
    usedAt: z.string().nullable(),
    usedAppointmentId: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    createdAt: z.string(),
    version: z.number().int(),
  }),
);
export type LoyaltyCouponResponse = z.infer<typeof loyaltyCouponSchema>;

export const loyaltyAccountSchema = responseSchema(
  'LoyaltyAccount',
  z.strictObject({
    customer: z.strictObject({ id: z.string(), name: z.string() }),
    mode: loyaltyModeSchema,
    balance: z.number().int().describe('Stamps of the current cycle or points'),
    lifetimeEarned: z.number().int(),
    transactions: z.array(loyaltyTransactionSchema).describe('Newest first, at most 100'),
    coupons: z.array(loyaltyCouponSchema).describe('Newest first, at most 100'),
  }),
);
export type LoyaltyAccountResponse = z.infer<typeof loyaltyAccountSchema>;
