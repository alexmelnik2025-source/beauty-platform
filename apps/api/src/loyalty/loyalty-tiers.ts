import type { LoyaltyTier, LoyaltyTierBasis, Prisma } from '../generated/prisma/client';

const DAY_MS = 86_400_000;

export interface TierStatus {
  basis: LoyaltyTierBasis;
  periodDays: number;
  /** Paid visits, or what the client paid (hundredths), in the period. */
  value: number;
  current: { name: string; discountPercent: number } | null;
  next: { name: string; threshold: number; missing: number } | null;
}

/** The highest tier reached and the next one, for a value (tiers in any order). */
export function tierFor(
  tiers: Pick<LoyaltyTier, 'name' | 'threshold' | 'discountPercent'>[],
  value: number,
): Pick<TierStatus, 'current' | 'next'> {
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  const reached = sorted.filter((t) => t.threshold <= value).at(-1);
  const next = sorted.find((t) => t.threshold > value);
  return {
    current: reached ? { name: reached.name, discountPercent: reached.discountPercent } : null,
    next: next
      ? { name: next.name, threshold: next.threshold, missing: next.threshold - value }
      : null,
  };
}

/**
 * A client's tier in the salon (task 10e): paid, "came" visits over the last periodDays — or
 * what they paid for them after coupons. null when the salon has no tiers.
 */
export async function tierStatus(
  db: Prisma.TransactionClient,
  program: {
    organizationId: string;
    tierBasis: LoyaltyTierBasis;
    tierPeriodDays: number;
    tiers: Pick<LoyaltyTier, 'name' | 'threshold' | 'discountPercent'>[];
  },
  customerId: string,
  now = new Date(),
): Promise<TierStatus | null> {
  if (program.tiers.length === 0) return null;
  const visits = await db.appointment.aggregate({
    where: {
      customerId,
      status: 'completed',
      paidAt: { not: null },
      startAt: { gte: new Date(now.getTime() - program.tierPeriodDays * DAY_MS) },
      location: { organizationId: program.organizationId },
    },
    _count: { _all: true },
    _sum: { priceGrosze: true, discountGrosze: true },
  });
  const value =
    program.tierBasis === 'visits'
      ? visits._count._all
      : (visits._sum.priceGrosze ?? 0) - (visits._sum.discountGrosze ?? 0);
  return {
    basis: program.tierBasis,
    periodDays: program.tierPeriodDays,
    value,
    ...tierFor(program.tiers, value),
  };
}
