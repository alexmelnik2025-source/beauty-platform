import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { VisitCouponsResponse } from '../booking/booking.responses';
import type { LoyaltyCoupon, LoyaltyProgram, Prisma } from '../generated/prisma/client';
import { tierStatus } from './loyalty-tiers';

/** Why a coupon cannot be used on a visit (null = it can). */
export type CouponProblem =
  'EXPIRED' | 'NOT_FOR_SERVICE' | 'NOT_COMBINABLE' | 'ALREADY_APPLIED' | 'NO_DISCOUNT';

const ERRORS: Record<CouponProblem, [string, string]> = {
  EXPIRED: ['COUPON_EXPIRED', 'This coupon is past its date'],
  NOT_FOR_SERVICE: [
    'COUPON_NOT_FOR_SERVICE',
    'This coupon does not cover the service of this visit',
  ],
  NOT_COMBINABLE: [
    'COUPON_NOT_COMBINABLE',
    'The salon does not allow more than one discount on a visit',
  ],
  ALREADY_APPLIED: ['COUPON_NOT_ACTIVE', 'This coupon is already used on this visit'],
  NO_DISCOUNT: [
    'COUPON_NO_DISCOUNT',
    'Nothing is left to take off: the visit already has the largest discount the salon allows',
  ],
};

/** The tier discount among a visit's discounts (it is a percentage discount like a coupon). */
const TIER = 'tier';

export const couponError = (problem: CouponProblem): AppException => {
  const [code, message] = ERRORS[problem];
  return new AppException(HttpStatus.CONFLICT, code, message);
};

type Rules = Pick<LoyaltyProgram, 'maxDiscountPercent' | 'allowStacking'>;
type CouponTerms = Pick<
  LoyaltyCoupon,
  'id' | 'kind' | 'discountPercent' | 'freeServiceId' | 'serviceIds' | 'status' | 'expiresAt'
>;
type Applied = Pick<LoyaltyCoupon, 'id' | 'kind' | 'discountGrosze'>;

export interface VisitPrice {
  serviceId: string;
  priceGrosze: number;
}

/**
 * What a coupon would take off a visit, by the salon's rules (task 10d):
 * - a percentage coupon: that share of the price, only for its services (none listed = any);
 * - a free-service coupon: the whole price, only for that service;
 * - percentage discounts together never exceed the salon's maximum share of the price
 *   (a free-service reward is the salon's own explicit promise, so the maximum does not cut it);
 * - one coupon per visit unless the salon allows combining them; never below zero.
 * Amounts are rounded down to whole hundredths.
 */
export function couponDiscount(
  rules: Rules,
  visit: VisitPrice,
  coupon: CouponTerms,
  applied: Applied[],
  now = new Date(),
): { discountGrosze: number; problem: CouponProblem | null } {
  const none = (problem: CouponProblem) => ({ discountGrosze: 0, problem });
  if (applied.some((a) => a.id === coupon.id)) return none('ALREADY_APPLIED');
  if (coupon.expiresAt !== null && coupon.expiresAt <= now) return none('EXPIRED');
  if (coupon.kind === 'free_service') {
    if (coupon.freeServiceId !== visit.serviceId) return none('NOT_FOR_SERVICE');
  } else if (coupon.serviceIds.length > 0 && !coupon.serviceIds.includes(visit.serviceId)) {
    return none('NOT_FOR_SERVICE');
  }
  if (applied.length > 0 && !rules.allowStacking) return none('NOT_COMBINABLE');

  const already = applied.reduce((sum, a) => sum + (a.discountGrosze ?? 0), 0);
  const left = Math.max(0, visit.priceGrosze - already);
  let amount: number;
  if (coupon.kind === 'free_service') {
    amount = left;
  } else {
    const percentAlready = applied
      .filter((a) => a.kind === 'discount_percent')
      .reduce((sum, a) => sum + (a.discountGrosze ?? 0), 0);
    const cap = Math.floor((visit.priceGrosze * rules.maxDiscountPercent) / 100) - percentAlready;
    const own = Math.floor((visit.priceGrosze * (coupon.discountPercent ?? 0)) / 100);
    amount = Math.min(own, cap, left);
  }
  if (amount <= 0) return none('NO_DISCOUNT');
  return { discountGrosze: amount, problem: null };
}

export interface CouponVisit {
  id: string;
  organizationId: string;
  serviceId: string;
  customerId: string | null;
  priceGrosze: number;
  /** Task 10e: the part of the visit's discount that is the client's tier discount. */
  tierDiscountGrosze: number;
  tierName: string | null;
  tierDiscountPercent: number | null;
  version: number;
}

/** Task 10e: the client's tier discount on a visit — used, or what it would take off. */
export interface VisitTier {
  name: string;
  discountPercent: number;
  discountGrosze: number;
  applied: boolean;
  /** A tier discount has no services or date, so only these can stop it. */
  problem: Extract<CouponProblem, 'NOT_COMBINABLE' | 'NO_DISCOUNT'> | null;
}

const noTierDiscount = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'TIER_NO_DISCOUNT',
    'The client has no tier with a discount in this salon',
  );

export const visitNotChangeable = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VISIT_NOT_CHANGEABLE',
    'Coupons can be changed only on a booked or "came" visit that is not marked as paid',
  );

const changedMeanwhile = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    'The appointment was changed by someone else. Reload and try again',
  );

/**
 * Coupons on visits. Every change runs inside the caller's transaction, together with the
 * visit's version check, so a coupon is never used twice and a visit's discount always
 * equals the sum of its coupons (the database checks the discount stays within the price).
 */
@Injectable()
export class VisitCoupons {
  /** The client's coupon (by id or by the code they show), in this salon only. */
  async findForVisit(
    tx: Prisma.TransactionClient,
    visit: Pick<CouponVisit, 'organizationId' | 'customerId'>,
    ref: { couponId?: string; code?: string },
  ): Promise<LoyaltyCoupon> {
    if (!visit.customerId) throw notFound('Coupon');
    const coupon = await tx.loyaltyCoupon.findFirst({
      where: {
        ...(ref.couponId ? { id: ref.couponId } : { code: normaliseCode(ref.code ?? '') }),
        // Another client's coupon (or another salon's) is "not found".
        account: {
          customerId: visit.customerId,
          program: { organizationId: visit.organizationId },
        },
      },
    });
    if (!coupon) throw notFound('Coupon');
    return coupon;
  }

  /** The salon's discount rules; coupons exist only where a program was saved (else its defaults). */
  async rules(db: Prisma.TransactionClient, organizationId: string): Promise<Rules> {
    const program = await db.loyaltyProgram.findUnique({
      where: { organizationId },
      select: { maxDiscountPercent: true, allowStacking: true },
    });
    return program ?? { maxDiscountPercent: 100, allowStacking: false };
  }

  /**
   * Coupons used on the visit and the client's other unused coupons in this salon, each with what
   * it would take off or why it cannot be used. showPrices=false hides the amounts.
   */
  async overview(
    db: Prisma.TransactionClient,
    visit: Omit<CouponVisit, 'version'>,
    showPrices: boolean,
  ): Promise<VisitCouponsResponse> {
    const used = await this.applied(db, visit.id);
    const applied = withTier(used, visit);
    const unused = visit.customerId
      ? await db.loyaltyCoupon.findMany({
          where: {
            status: 'active',
            account: {
              customerId: visit.customerId,
              program: { organizationId: visit.organizationId },
            },
          },
          orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
          take: 50,
        })
      : [];
    const rules = await this.rules(db, visit.organizationId);
    const tier = await this.tier(db, visit, rules, applied);
    return {
      tier: tier && {
        ...tier,
        discountGrosze: showPrices && tier.problem === null ? tier.discountGrosze : null,
      },
      applied: used.map((c) => ({
        ...visitCouponFields(c),
        discountGrosze: showPrices ? (c.discountGrosze ?? 0) : null,
      })),
      available: unused.map((c) => {
        const { discountGrosze, problem } = couponDiscount(rules, visit, c, applied);
        return {
          ...visitCouponFields(c),
          expiresAt: c.expiresAt?.toISOString() ?? null,
          discountGrosze: showPrices && problem === null ? discountGrosze : null,
          problem: problem === 'ALREADY_APPLIED' ? null : problem,
        };
      }),
    };
  }

  /** Coupons used on these visits, by visit (only visits with a discount are looked up). */
  async usedOn(
    db: Prisma.TransactionClient,
    rows: { id: string; discountGrosze: number }[],
  ): Promise<Map<string, LoyaltyCoupon[]>> {
    const ids = rows.filter((r) => r.discountGrosze > 0).map((r) => r.id);
    const byVisit = new Map<string, LoyaltyCoupon[]>();
    if (ids.length === 0) return byVisit;
    const coupons = await db.loyaltyCoupon.findMany({
      where: { usedAppointmentId: { in: ids }, status: 'used' },
      orderBy: [{ usedAt: 'asc' }, { id: 'asc' }],
    });
    for (const c of coupons) {
      const list = byVisit.get(c.usedAppointmentId!) ?? [];
      list.push(c);
      byVisit.set(c.usedAppointmentId!, list);
    }
    return byVisit;
  }

  /**
   * The client's tier discount on the visit (task 10e): the one used (as it was then), or the
   * client's current tier and what it would take off by the same rules as a coupon. null when
   * there is nothing to show (no client, no program or tiers, or a tier without a discount).
   */
  async tier(
    db: Prisma.TransactionClient,
    visit: Omit<CouponVisit, 'version'>,
    rules: Rules,
    applied: Applied[],
    now = new Date(),
  ): Promise<VisitTier | null> {
    if (visit.tierDiscountGrosze > 0) {
      return {
        name: visit.tierName ?? '',
        discountPercent: visit.tierDiscountPercent ?? 0,
        discountGrosze: visit.tierDiscountGrosze,
        applied: true,
        problem: null,
      };
    }
    if (!visit.customerId) return null;
    const program = await db.loyaltyProgram.findUnique({
      where: { organizationId: visit.organizationId },
      include: { tiers: true },
    });
    if (!program?.enabled) return null;
    const status = await tierStatus(db, program, visit.customerId, now);
    const current = status?.current;
    if (!current || current.discountPercent <= 0) return null;
    const { discountGrosze, problem } = couponDiscount(
      rules,
      visit,
      {
        id: TIER,
        kind: 'discount_percent',
        discountPercent: current.discountPercent,
        freeServiceId: null,
        serviceIds: [],
        status: 'active',
        expiresAt: null,
      },
      applied,
      now,
    );
    return {
      ...current,
      discountGrosze,
      applied: false,
      problem: problem === 'NOT_COMBINABLE' || problem === 'NO_DISCOUNT' ? problem : null,
    };
  }

  /**
   * Uses the client's tier discount on a visit (task 10e): the client's tier now, by the salon's
   * rules (maximum share, combining with coupons). Returns what it took off.
   */
  async applyTier(tx: Prisma.TransactionClient, visit: CouponVisit): Promise<VisitTier> {
    if (visit.tierDiscountGrosze > 0) throw couponError('ALREADY_APPLIED');
    const rules = await this.rules(tx, visit.organizationId);
    const tier = await this.tier(
      tx,
      visit,
      rules,
      withTier(await this.applied(tx, visit.id), visit),
    );
    if (!tier) throw noTierDiscount();
    if (tier.problem) throw couponError(tier.problem);
    const changed = await tx.appointment.updateMany({
      where: {
        id: visit.id,
        version: visit.version,
        status: { in: ['confirmed', 'completed'] },
        paidAt: null,
        tierDiscountGrosze: 0,
      },
      data: {
        discountGrosze: { increment: tier.discountGrosze },
        tierDiscountGrosze: tier.discountGrosze,
        tierName: tier.name,
        tierDiscountPercent: tier.discountPercent,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw changedMeanwhile();
    return { ...tier, applied: true };
  }

  /** Takes the tier discount off a visit that is not paid yet; the price goes back up. */
  async removeTier(
    tx: Prisma.TransactionClient,
    visit: CouponVisit,
  ): Promise<{ name: string | null; discountGrosze: number }> {
    if (visit.tierDiscountGrosze <= 0) throw notFound('Tier discount');
    const changed = await tx.appointment.updateMany({
      where: {
        id: visit.id,
        version: visit.version,
        status: { in: ['confirmed', 'completed'] },
        paidAt: null,
        tierDiscountGrosze: visit.tierDiscountGrosze,
      },
      data: {
        discountGrosze: { decrement: visit.tierDiscountGrosze },
        ...NO_TIER,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw changedMeanwhile();
    return { name: visit.tierName, discountGrosze: visit.tierDiscountGrosze };
  }

  async applied(tx: Prisma.TransactionClient, appointmentId: string): Promise<LoyaltyCoupon[]> {
    return tx.loyaltyCoupon.findMany({
      where: { usedAppointmentId: appointmentId, status: 'used' },
      orderBy: [{ usedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Uses a coupon on a visit: the coupon becomes "used" for this visit, the visit's discount
   * grows by what it takes off. 409 with the reason when the salon's rules do not allow it.
   */
  async apply(
    tx: Prisma.TransactionClient,
    visit: CouponVisit,
    coupon: LoyaltyCoupon,
    rules: Rules,
  ): Promise<number> {
    if (coupon.status !== 'active') throw couponError('ALREADY_APPLIED');
    const applied = withTier(await this.applied(tx, visit.id), visit);
    const { discountGrosze, problem } = couponDiscount(rules, visit, coupon, applied);
    if (problem) throw couponError(problem);
    const visitChanged = await tx.appointment.updateMany({
      where: {
        id: visit.id,
        version: visit.version,
        status: { in: ['confirmed', 'completed'] },
        paidAt: null,
      },
      data: { discountGrosze: { increment: discountGrosze }, version: { increment: 1 } },
    });
    // The checks before the transaction passed, so someone changed the visit meanwhile.
    if (visitChanged.count !== 1) throw changedMeanwhile();
    const couponChanged = await tx.loyaltyCoupon.updateMany({
      where: { id: coupon.id, status: 'active' },
      data: {
        status: 'used',
        usedAppointmentId: visit.id,
        usedAt: new Date(),
        discountGrosze,
        version: { increment: 1 },
      },
    });
    // Used on another visit at the same moment.
    if (couponChanged.count !== 1) throw couponError('ALREADY_APPLIED');
    return discountGrosze;
  }

  /** Takes a coupon off a visit that is not paid yet: it is active again, the price goes back up. */
  async remove(
    tx: Prisma.TransactionClient,
    visit: CouponVisit,
    couponId: string,
  ): Promise<LoyaltyCoupon> {
    const coupon = await tx.loyaltyCoupon.findFirst({
      where: { id: couponId, usedAppointmentId: visit.id, status: 'used' },
    });
    if (!coupon) throw notFound('Coupon');
    const visitChanged = await tx.appointment.updateMany({
      where: {
        id: visit.id,
        version: visit.version,
        status: { in: ['confirmed', 'completed'] },
        paidAt: null,
      },
      data: {
        discountGrosze: { decrement: coupon.discountGrosze ?? 0 },
        version: { increment: 1 },
      },
    });
    // The checks before the transaction passed, so someone changed the visit meanwhile.
    if (visitChanged.count !== 1) throw changedMeanwhile();
    await this.release(tx, [coupon.id]);
    return coupon;
  }

  /**
   * A cancelled or "did not come" visit gives its coupons back to the client (they were not
   * used after all). Returns how many. The caller has already changed the visit's status.
   */
  async releaseForVisit(tx: Prisma.TransactionClient, appointmentId: string): Promise<number> {
    const coupons = await this.applied(tx, appointmentId);
    // The tier discount goes too: the visit did not happen, there is nothing to take it off.
    const { count: hadTier } = await tx.appointment.updateMany({
      where: { id: appointmentId, tierDiscountGrosze: { gt: 0 } },
      data: { discountGrosze: 0, ...NO_TIER },
    });
    if (coupons.length === 0) return 0;
    if (hadTier === 0) {
      await tx.appointment.update({
        where: { id: appointmentId },
        data: { discountGrosze: 0 },
      });
    }
    await this.release(
      tx,
      coupons.map((c) => c.id),
    );
    return coupons.length;
  }

  private async release(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
    await tx.loyaltyCoupon.updateMany({
      where: { id: { in: ids }, status: 'used' },
      data: {
        status: 'active',
        usedAppointmentId: null,
        usedAt: null,
        discountGrosze: null,
        version: { increment: 1 },
      },
    });
  }
}

const NO_TIER = { tierDiscountGrosze: 0, tierName: null, tierDiscountPercent: null } as const;

/** A visit's coupons and its tier discount as one more percentage discount. */
function withTier(used: Applied[], visit: Pick<CouponVisit, 'tierDiscountGrosze'>): Applied[] {
  return visit.tierDiscountGrosze > 0
    ? [...used, { id: TIER, kind: 'discount_percent', discountGrosze: visit.tierDiscountGrosze }]
    : used;
}

/** What every coupon list shows about a coupon. */
export function visitCouponFields(c: LoyaltyCoupon) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    kind: c.kind,
    discountPercent: c.discountPercent,
    version: c.version,
  };
}

/** "k7qm 4xtb", "K7QM4XTB" → "K7QM-4XTB" (as printed on the coupon). */
export function normaliseCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
