import { ApiError, type AppointmentDetail, type VisitCoupons } from './api';
import type { Dictionary } from './i18n';

/**
 * Task 343: the client's loyalty coupons and tier discount on a visit in the business app (in the
 * cabinet — the visit window, task 10d/10e). Whoever may change the visit uses one before "Paid";
 * the salon's rules are checked by the server. Tested in Vitest (test/visitCoupons.test.ts).
 */

/** Only on a booked or "came" visit of a known client that is not paid yet. */
export function mayUseCoupons(
  visit: Pick<AppointmentDetail, 'customer' | 'paidAt' | 'status'>,
  canChange: boolean,
): boolean {
  return (
    canChange &&
    visit.customer !== null &&
    visit.paidAt === null &&
    (visit.status === 'confirmed' || visit.status === 'completed')
  );
}

/** Something to show: a tier, a coupon used, or one the client could use. */
export function hasCoupons(c: VisitCoupons): boolean {
  return c.tier !== null || c.applied.length > 0 || c.available.length > 0;
}

/** "K7QM-4XTB" as the client says it: spaces out, upper case; 4–20 characters (the server's limits). */
export function couponCode(typed: string): string | null {
  const code = typed.replace(/\s+/g, '').toUpperCase();
  return code.length >= 4 && code.length <= 20 ? code : null;
}

/** Why the server refused, in words; null = say the usual error. */
export function couponErrorText(error: unknown, t: Dictionary): string | null {
  if (!(error instanceof ApiError)) return null;
  const e = t.visit.coupons.error;
  switch (error.code) {
    case 'NOT_FOUND':
      return e.notFound;
    case 'COUPON_EXPIRED':
      return e.expired;
    case 'COUPON_NOT_FOR_SERVICE':
      return e.notForService;
    case 'COUPON_NOT_COMBINABLE':
      return e.notCombinable;
    case 'COUPON_NO_DISCOUNT':
    case 'TIER_NO_DISCOUNT':
      return e.noDiscount;
    case 'COUPON_NOT_ACTIVE':
      return e.notActive;
    case 'VISIT_NOT_CHANGEABLE':
      return e.notChangeable;
    default:
      return null;
  }
}
