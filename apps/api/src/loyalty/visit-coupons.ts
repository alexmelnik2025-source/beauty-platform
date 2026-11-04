import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { VisitCouponsResponse } from '../booking/booking.responses';
import type { LoyaltyCoupon, LoyaltyProgram, Prisma } from '../generated/prisma/client';

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
  version: number;
}

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
    const applied = await this.applied(db, visit.id);
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
    return {
      applied: applied.map((c) => ({
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
    const applied = await this.applied(tx, visit.id);
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
    if (coupons.length === 0) return 0;
    await tx.appointment.update({
      where: { id: appointmentId },
      data: { discountGrosze: 0 },
    });
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
