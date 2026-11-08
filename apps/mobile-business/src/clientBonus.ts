import { ApiError, type LoyaltyAccount, type LoyaltyReward } from './api';
import type { Dictionary } from './i18n';

/**
 * Task 340: "Program lojalnościowy" in the client card of the business app (owners and managers;
 * in the cabinet — "Bonusy" of the client card, task 10b): exchange stamps or points for a reward
 * (the client gets a coupon), cancel an unused coupon (the stamps or points come back), a manual
 * change with a reason, and the client's latest operations. The server checks the role, the
 * balance and the program; here only what the form needs. Tested in Vitest
 * (test/clientBonus.test.ts).
 */

export type AdjustProblem = 'points' | 'reason';

/** "+5" or "-3" and a reason of 3–500 characters (the server's limits). */
export function parseAdjustment(
  points: string,
  reason: string,
): { ok: true; points: number; reason: string } | { ok: false; problem: AdjustProblem } {
  const raw = points.trim().replace(/\s+/g, '').replace('−', '-');
  const n = /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n === 0 || n < -100_000 || n > 100_000) {
    return { ok: false, problem: 'points' };
  }
  const why = reason.trim();
  if (why.length < 3 || why.length > 500) return { ok: false, problem: 'reason' };
  return { ok: true, points: n, reason: why };
}

/** Rewards the client can take now: enough stamps or points (cheaper first, as in the catalogue). */
export function rewardChoices(
  account: Pick<LoyaltyAccount, 'balance'>,
  rewards: LoyaltyReward[],
): { reward: LoyaltyReward; enough: boolean }[] {
  return rewards
    .filter((r) => r.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.cost - b.cost || a.name.localeCompare(b.name))
    .map((reward) => ({ reward, enough: account.balance >= reward.cost }));
}

/** Coupons that can still be cancelled: active and not past their last day. */
export function cancellableCoupons(
  account: Pick<LoyaltyAccount, 'coupons'>,
  now = new Date(),
): LoyaltyAccount['coupons'] {
  return account.coupons.filter(
    (c) =>
      c.status === 'active' && (c.expiresAt === null || Date.parse(c.expiresAt) > now.getTime()),
  );
}

/** The card is worth showing to an owner or a manager when the program is on or something is there. */
export function showBonusCard(
  account: Pick<LoyaltyAccount, 'balance' | 'lifetimeEarned' | 'coupons' | 'transactions'>,
  programEnabled: boolean,
): boolean {
  return (
    programEnabled ||
    account.balance > 0 ||
    account.lifetimeEarned > 0 ||
    account.coupons.length > 0 ||
    account.transactions.length > 0
  );
}

/** What went wrong, in words: not enough, the program is off, the coupon is already used. */
export function bonusErrorText(error: unknown, t: Dictionary): string | null {
  if (!(error instanceof ApiError)) return null;
  const b = t.clients.bonus;
  if (error.code === 'LOYALTY_NOT_ENOUGH') return b.notEnough;
  if (error.code === 'LOYALTY_DISABLED') return b.disabled;
  if (error.code === 'COUPON_NOT_ACTIVE' || error.code === 'VERSION_CONFLICT') return b.changed;
  return null;
}
