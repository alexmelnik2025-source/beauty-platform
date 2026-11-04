import { z } from 'zod';
import type { LoyaltyMode, LoyaltyRewardKind, LoyaltyTierBasis } from '../generated/prisma/client';

export const loyaltyModeSchema = z.enum(['stamps', 'points'] satisfies LoyaltyMode[]);
export const loyaltyTierBasisSchema = z.enum(['visits', 'spend'] satisfies LoyaltyTierBasis[]);

export const loyaltyRewardKindSchema = z.enum([
  'discount_percent',
  'free_service',
] satisfies LoyaltyRewardKind[]);

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

const rewardFields = z.object({
  name: z.string().trim().min(1).max(80),
  kind: loyaltyRewardKindSchema,
  /** discount_percent only. */
  discountPercent: z.number().int().min(1).max(100).nullable().default(null),
  /** free_service only: a service of the salon. */
  freeServiceId: z.uuid().nullable().default(null),
  /** Stamps or points the reward costs. */
  cost: z.number().int().min(1).max(100_000),
  /** The coupon works only for these services; empty = any service. */
  serviceIds: z
    .array(z.uuid())
    .max(200)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Each service may appear only once',
    }),
  /** Days the coupon is valid after it was taken; null = no limit. */
  couponValidityDays: z.number().int().min(1).max(3650).nullable().default(null),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

/** The kind decides which field is filled: a discount has a percent, a free service a service. */
function kindMatchesFields(
  reward: { kind: LoyaltyRewardKind; discountPercent: number | null; freeServiceId: string | null },
  ctx: z.RefinementCtx,
): void {
  if (reward.kind === 'discount_percent') {
    if (reward.discountPercent === null) {
      ctx.addIssue({ code: 'custom', path: ['discountPercent'], message: 'Required' });
    }
    if (reward.freeServiceId !== null) {
      ctx.addIssue({ code: 'custom', path: ['freeServiceId'], message: 'Only for free_service' });
    }
  } else {
    if (reward.freeServiceId === null) {
      ctx.addIssue({ code: 'custom', path: ['freeServiceId'], message: 'Required' });
    }
    if (reward.discountPercent !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['discountPercent'],
        message: 'Only for discount_percent',
      });
    }
  }
}

export const createLoyaltyRewardSchema = rewardFields.superRefine(kindMatchesFields);

export const updateLoyaltyRewardSchema = rewardFields
  .extend({ version: z.number().int().min(1) })
  .superRefine(kindMatchesFields);

export const listLoyaltyRewardsSchema = z.object({
  /** "true" also lists removed rewards (their coupons may still be in use). */
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const redeemLoyaltyRewardSchema = z.object({ rewardId: z.uuid() });

export const adjustLoyaltyBalanceSchema = z.object({
  /** + adds, − takes away. The balance may not go below zero. */
  points: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .refine((n) => n !== 0, { message: 'Must not be 0' }),
  /** Why: shown in the history. */
  reason: z.string().trim().min(3).max(500),
});

export const cancelLoyaltyCouponSchema = z.object({ version: z.number().int().min(1) });

export const setPaidSchema = z.object({
  version: z.number().int().min(1),
  paid: z.boolean(),
});

/** Task 10d: a coupon on a visit, picked from the list (couponId) or typed from the client's screen (code). */
export const applyVisitCouponSchema = z
  .object({
    version: z.number().int().min(1),
    couponId: z.uuid().optional(),
    code: z.string().trim().min(4).max(20).optional(),
  })
  .refine((v) => (v.couponId === undefined) !== (v.code === undefined), {
    message: 'Send either couponId or code',
    path: ['couponId'],
  });

export const removeVisitCouponSchema = z.object({ version: z.number().int().min(1) });

export type ApplyVisitCouponInput = z.infer<typeof applyVisitCouponSchema>;
export type RemoveVisitCouponInput = z.infer<typeof removeVisitCouponSchema>;
/** Task 10e: the salon's tiers, replaced as a whole (an empty list switches tiers off). */
export const replaceLoyaltyTiersSchema = z.object({
  basis: loyaltyTierBasisSchema,
  periodDays: z.number().int().min(30).max(1095),
  tiers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        /** Visits, or hundredths of the currency (by basis); 0 = every client. */
        threshold: z.number().int().min(0).max(100_000_000),
        discountPercent: z.number().int().min(0).max(100),
      }),
    )
    .max(8)
    .refine((tiers) => new Set(tiers.map((t) => t.threshold)).size === tiers.length, {
      message: 'Two tiers cannot have the same threshold',
    }),
});
export type ReplaceLoyaltyTiersInput = z.infer<typeof replaceLoyaltyTiersSchema>;

/** Task 19: extra stamps or points at chosen specialists and/or weekdays, replaced as a whole. */
export const replaceLoyaltyBonusRulesSchema = z.object({
  rules: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(60),
          /** Empty = every specialist. */
          staffIds: z
            .array(z.uuid())
            .max(100)
            .default([])
            .refine((ids) => new Set(ids).size === ids.length, {
              message: 'Each specialist may appear only once',
            }),
          /** ISO weekdays, 1 = Monday … 7 = Sunday; empty = every day. */
          weekdays: z
            .array(z.number().int().min(1).max(7))
            .max(7)
            .default([])
            .refine((days) => new Set(days).size === days.length, {
              message: 'Each day may appear only once',
            }),
          /** The visit's stamps or points are multiplied by this (1 = no change). */
          multiplier: z.number().int().min(1).max(10).default(1),
          /** Added on top. */
          extraPoints: z.number().int().min(0).max(100_000).default(0),
        })
        .refine((r) => r.multiplier > 1 || r.extraPoints > 0, {
          message: 'A rule must give something extra: multiplier above 1 or extra points',
          path: ['multiplier'],
        }),
    )
    .max(20),
});
export type ReplaceLoyaltyBonusRulesInput = z.infer<typeof replaceLoyaltyBonusRulesSchema>;

export type UpdateLoyaltyProgramInput = z.infer<typeof updateLoyaltyProgramSchema>;
export type ReplaceEarnRulesInput = z.infer<typeof replaceEarnRulesSchema>;
export type ListLoyaltyTransactionsQuery = z.infer<typeof listLoyaltyTransactionsSchema>;
export type SetPaidInput = z.infer<typeof setPaidSchema>;
export type CreateLoyaltyRewardInput = z.infer<typeof createLoyaltyRewardSchema>;
export type UpdateLoyaltyRewardInput = z.infer<typeof updateLoyaltyRewardSchema>;
export type ListLoyaltyRewardsQuery = z.infer<typeof listLoyaltyRewardsSchema>;
export type RedeemLoyaltyRewardInput = z.infer<typeof redeemLoyaltyRewardSchema>;
export type AdjustLoyaltyBalanceInput = z.infer<typeof adjustLoyaltyBalanceSchema>;
export type CancelLoyaltyCouponInput = z.infer<typeof cancelLoyaltyCouponSchema>;
