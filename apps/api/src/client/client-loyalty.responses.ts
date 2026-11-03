import { z } from 'zod';
import { responseSchema } from '../common/openapi';
import { loyaltyTransactionTypeSchema } from '../loyalty/loyalty.responses';
import { loyaltyModeSchema, loyaltyRewardKindSchema } from '../loyalty/loyalty.schemas';

/**
 * "My bonuses" (task 10c): what the client sees of a salon's loyalty program.
 * Never staff notes, who made a change or other clients.
 */

const clientLoyaltyRewardSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: loyaltyRewardKindSchema,
  discountPercent: z.number().int().nullable(),
  freeServiceName: z.string().nullable().describe('free_service only'),
  serviceNames: z.array(z.string()).describe('Only for these services; empty = any'),
  cost: z.number().int().describe('Stamps or points'),
  missing: z.number().int().describe('Still to collect; 0 = can be taken now'),
  couponValidityDays: z.number().int().nullable(),
});

const clientLoyaltyCouponSchema = z.strictObject({
  id: z.string(),
  code: z.string().describe('Shown at the salon'),
  name: z.string(),
  kind: loyaltyRewardKindSchema,
  discountPercent: z.number().int().nullable(),
  freeServiceName: z.string().nullable(),
  serviceNames: z.array(z.string()),
  status: z.enum(['active', 'used', 'expired']).describe('Cancelled coupons are not shown'),
  expiresAt: z.string().nullable(),
  usedAt: z.string().nullable(),
  createdAt: z.string(),
});

const clientLoyaltyHistorySchema = z.strictObject({
  id: z.string(),
  type: loyaltyTransactionTypeSchema,
  points: z.number().int().describe('Signed: + earned, − taken back or spent'),
  balanceAfter: z.number().int(),
  serviceName: z.string().nullable().describe('The visit it was for, if any'),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const clientLoyaltyCardSchema = z.strictObject({
  // name: the salon as clients know it (its online-booking place), not the legal name.
  organization: z.strictObject({ id: z.string(), name: z.string() }),
  bookingSlug: z.string().nullable().describe('A location of the salon that takes online booking'),
  enabled: z
    .boolean()
    .describe('false: the salon switched the program off; coupons already taken are shown'),
  mode: loyaltyModeSchema,
  balance: z.number().int().describe('Stamps of the current cycle or points'),
  lifetimeEarned: z.number().int(),
  earning: z.strictObject({
    stampsPerVisit: z.number().int(),
    pointsPerUnit: z.number().int(),
    spendUnitGrosze: z.number().int(),
    minSpendGrosze: z.number().int(),
    pointsValidityDays: z.number().int().nullable(),
  }),
  next: z
    .strictObject({
      rewardId: z.string(),
      missing: z.number().int().describe('Stamps or points still to collect'),
      visits: z
        .number()
        .int()
        .nullable()
        .describe('stamps mode: paid visits still needed; null in points mode'),
    })
    .nullable()
    .describe('The cheapest reward that cannot be taken yet; null when all can'),
  rewards: z.array(clientLoyaltyRewardSchema).describe('Cheapest first'),
  coupons: z.array(clientLoyaltyCouponSchema).describe('Active first, then newest; at most 20'),
  history: z.array(clientLoyaltyHistorySchema).describe('Newest first, at most 30'),
});
export type ClientLoyaltyCard = z.infer<typeof clientLoyaltyCardSchema>;

export const clientLoyaltySchema = responseSchema(
  'ClientLoyalty',
  z.strictObject({ items: z.array(clientLoyaltyCardSchema) }),
);
export type ClientLoyaltyResponse = z.infer<typeof clientLoyaltySchema>;
