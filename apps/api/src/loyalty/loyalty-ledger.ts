import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import type {
  LoyaltyCoupon,
  LoyaltyProgram,
  LoyaltyReward,
  Prisma,
} from '../generated/prisma/client';

type ProgramRules = Pick<
  LoyaltyProgram,
  'mode' | 'stampsPerVisit' | 'pointsPerUnit' | 'spendUnitGrosze' | 'minSpendGrosze'
>;

/**
 * Stamps or points for one paid visit, by the salon's own rules:
 * cheaper than the minimum → 0; a rule for the service → its number;
 * otherwise stamps per visit, or points per full spend unit (rounded down).
 */
export function earnAmount(
  program: ProgramRules,
  servicePoints: number | undefined,
  priceGrosze: number,
): number {
  if (priceGrosze < program.minSpendGrosze) return 0;
  if (servicePoints !== undefined) return servicePoints;
  if (program.mode === 'stamps') return program.stampsPerVisit;
  return Math.floor((priceGrosze * program.pointsPerUnit) / program.spendUnitGrosze);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UUIDv7 (time-ordered), like the ids Prisma creates, for the one row inserted with raw SQL. */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Letters and digits that cannot be mixed up when read aloud or typed (no 0/O, 1/I/L). */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A coupon code the client shows at the salon, e.g. "K7QM-4XTB" (31^8 ≈ 850 billion codes). */
export function couponCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export const notEnough = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'LOYALTY_NOT_ENOUGH',
    'The client does not have enough stamps or points',
  );

type RedeemProgram = Pick<LoyaltyProgram, 'id' | 'mode'>;

export interface PaidVisit {
  id: string;
  organizationId: string;
  serviceId: string;
  customerId: string | null;
  priceGrosze: number;
}

/**
 * The only code that changes loyalty balances. Always runs inside the caller's
 * transaction, together with the change of the visit itself, and locks the
 * client's account row, so two requests can never take the balance below zero
 * (the database CHECK constraint is the last line of defence).
 */
@Injectable()
export class LoyaltyLedger {
  /** Stamps or points for a visit just marked as paid. Returns what was earned (0 = nothing). */
  async earnForVisit(
    tx: Prisma.TransactionClient,
    visit: PaidVisit,
    actorUserId: string,
  ): Promise<number> {
    if (!visit.customerId) return 0;
    const program = await tx.loyaltyProgram.findUnique({
      where: { organizationId: visit.organizationId },
      include: { earnRules: { where: { serviceId: visit.serviceId } } },
    });
    if (!program?.enabled) return 0;
    const points = earnAmount(program, program.earnRules[0]?.points, visit.priceGrosze);
    if (points <= 0) return 0;

    const account = await this.lockedAccount(tx, program.id, visit.customerId);
    // Earned again after a refund: a new key, but never two earns for one payment.
    const earlier = await tx.loyaltyTransaction.count({
      where: { appointmentId: visit.id, type: 'earn' },
    });
    const updated = await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { balance: { increment: points }, lifetimeEarned: { increment: points } },
    });
    const expiresAt =
      program.mode === 'points' && program.pointsValidityDays !== null
        ? new Date(Date.now() + program.pointsValidityDays * DAY_MS)
        : null;
    await tx.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        type: 'earn',
        points,
        balanceAfter: updated.balance,
        appointmentId: visit.id,
        dedupeKey: `earn:${visit.id}:${earlier}`,
        expiresAt,
        actorUserId,
      },
    });
    return points;
  }

  /**
   * Takes back what a visit earned (refund, "did not come"). If the client has
   * already spent part of it, only what is left is taken: the balance never goes
   * below zero, and the note says how much could not be taken back.
   * Returns how much was taken (0 = there was nothing to take back).
   */
  async reverseForVisit(
    tx: Prisma.TransactionClient,
    appointmentId: string,
    actorUserId: string,
  ): Promise<number> {
    const earn = await tx.loyaltyTransaction.findFirst({
      where: { appointmentId, type: 'earn', reversedBy: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!earn) return 0;
    const [locked] = await tx.$queryRaw<{ balance: number }[]>`
      SELECT balance FROM loyalty_account WHERE id = ${earn.accountId}::uuid FOR UPDATE`;
    const taken = Math.min(earn.points, locked?.balance ?? 0);
    const updated = await tx.loyaltyAccount.update({
      where: { id: earn.accountId },
      data: { balance: { decrement: taken }, lifetimeEarned: { decrement: earn.points } },
    });
    await tx.loyaltyTransaction.create({
      data: {
        accountId: earn.accountId,
        type: 'reverse',
        points: -taken,
        balanceAfter: updated.balance,
        appointmentId,
        reversesId: earn.id,
        dedupeKey: `reverse:${earn.id}`,
        actorUserId,
        note:
          taken < earn.points
            ? `${earn.points - taken} of ${earn.points} were already spent and stay with the client`
            : null,
      },
    });
    return taken;
  }

  /**
   * Exchanges stamps or points for a reward: the client gets a coupon with a copy of the
   * reward's terms. Points: the reward's cost is taken. Stamps: the whole current cycle
   * is taken (the card starts again from zero), the client needs at least the cost.
   * 409 LOYALTY_NOT_ENOUGH when the balance is too small — checked with the row locked,
   * so two exchanges at the same moment can never spend the same points twice.
   */
  async redeem(
    tx: Prisma.TransactionClient,
    program: RedeemProgram,
    customerId: string,
    reward: LoyaltyReward,
    actorUserId: string | null,
  ): Promise<LoyaltyCoupon> {
    const account = await this.lockedAccount(tx, program.id, customerId);
    if (account.balance < reward.cost) throw notEnough();
    const taken = program.mode === 'stamps' ? account.balance : reward.cost;
    const updated = await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { balance: { decrement: taken } },
    });
    const couponId = uuidV7();
    const redeem = await tx.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        type: 'redeem',
        points: -taken,
        balanceAfter: updated.balance,
        dedupeKey: `redeem:${couponId}`,
        actorUserId,
        note:
          taken > reward.cost
            ? `${reward.name}: the card starts again (${taken} stamps, the reward needs ${reward.cost})`
            : reward.name,
      },
    });
    return tx.loyaltyCoupon.create({
      data: {
        id: couponId,
        accountId: account.id,
        rewardId: reward.id,
        code: couponCode(),
        name: reward.name,
        kind: reward.kind,
        discountPercent: reward.discountPercent,
        freeServiceId: reward.freeServiceId,
        serviceIds: reward.serviceIds,
        cost: taken,
        redeemTransactionId: redeem.id,
        expiresAt:
          reward.couponValidityDays === null
            ? null
            : new Date(Date.now() + reward.couponValidityDays * DAY_MS),
      },
    });
  }

  /**
   * Withdraws an unused coupon: what it cost goes back to the client (a "reverse" of
   * the exchange). Returns null when the coupon is no longer active or the version is old.
   */
  async cancelCoupon(
    tx: Prisma.TransactionClient,
    coupon: Pick<LoyaltyCoupon, 'id' | 'accountId' | 'redeemTransactionId' | 'name'>,
    version: number,
    actorUserId: string,
  ): Promise<LoyaltyCoupon | null> {
    await tx.$queryRaw`SELECT id FROM loyalty_account WHERE id = ${coupon.accountId}::uuid FOR UPDATE`;
    const changed = await tx.loyaltyCoupon.updateMany({
      where: { id: coupon.id, status: 'active', version },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledByUserId: actorUserId,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) return null;
    const redeem = await tx.loyaltyTransaction.findUniqueOrThrow({
      where: { id: coupon.redeemTransactionId },
    });
    const updated = await tx.loyaltyAccount.update({
      where: { id: coupon.accountId },
      data: { balance: { increment: -redeem.points } },
    });
    await tx.loyaltyTransaction.create({
      data: {
        accountId: coupon.accountId,
        type: 'reverse',
        points: -redeem.points,
        balanceAfter: updated.balance,
        reversesId: redeem.id,
        dedupeKey: `reverse:${redeem.id}`,
        actorUserId,
        note: `${coupon.name}: coupon cancelled`,
      },
    });
    return tx.loyaltyCoupon.findUniqueOrThrow({ where: { id: coupon.id } });
  }

  /**
   * A manual correction by the owner or manager, always with a reason. Added points
   * get the program's validity like earned ones; the balance may not go below zero.
   * "Earned in total" does not change: it counts only what visits brought.
   */
  async adjust(
    tx: Prisma.TransactionClient,
    program: Pick<LoyaltyProgram, 'id' | 'mode' | 'pointsValidityDays'>,
    customerId: string,
    points: number,
    reason: string,
    actorUserId: string,
  ): Promise<void> {
    const account = await this.lockedAccount(tx, program.id, customerId);
    if (account.balance + points < 0) throw notEnough();
    const updated = await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { balance: { increment: points } },
    });
    await tx.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        type: 'adjust',
        points,
        balanceAfter: updated.balance,
        dedupeKey: `adjust:${uuidV7()}`,
        expiresAt:
          points > 0 && program.mode === 'points' && program.pointsValidityDays !== null
            ? new Date(Date.now() + program.pointsValidityDays * DAY_MS)
            : null,
        actorUserId,
        note: reason,
      },
    });
  }

  /**
   * Points past their date (task 10f). Spending always uses the points that expire first, so
   * what is due now = points granted with a date already passed − everything spent − what
   * expired before; never more than the balance. A taken-back visit's points are not counted
   * (in the client's favour). Adds one "expire" entry; returns how many points expired.
   */
  async expireDue(
    tx: Prisma.TransactionClient,
    accountId: string,
    now = new Date(),
  ): Promise<number> {
    const [locked] = await tx.$queryRaw<{ balance: number }[]>`
      SELECT balance FROM loyalty_account WHERE id = ${accountId}::uuid FOR UPDATE`;
    const due = await this.dueBy(tx, accountId, locked?.balance ?? 0, now);
    if (due <= 0) return 0;
    const updated = await tx.loyaltyAccount.update({
      where: { id: accountId },
      data: { balance: { decrement: due } },
    });
    const count = await tx.loyaltyTransaction.count({ where: { accountId, type: 'expire' } });
    await tx.loyaltyTransaction.create({
      data: {
        accountId,
        type: 'expire',
        points: -due,
        balanceAfter: updated.balance,
        dedupeKey: `expire:${accountId}:${count}`,
        actorUserId: null,
      },
    });
    return due;
  }

  /**
   * How many points will have expired by `at` that have not expired yet: granted with a date up
   * to `at` − spent − already expired, within the balance. Reads only; `expireDue` writes.
   */
  async dueBy(
    db: Prisma.TransactionClient,
    accountId: string,
    balance: number,
    at: Date,
  ): Promise<number> {
    if (balance <= 0) return 0;
    const sum = async (where: Prisma.LoyaltyTransactionWhereInput): Promise<number> =>
      (
        await db.loyaltyTransaction.aggregate({
          where: { accountId, ...where },
          _sum: { points: true },
        })
      )._sum.points ?? 0;
    const granted = await sum({
      type: { in: ['earn', 'adjust'] },
      points: { gt: 0 },
      expiresAt: { lte: at },
      reversedBy: { is: null },
    });
    if (granted <= 0) return 0;
    const spent =
      -(await sum({ type: 'redeem' })) -
      (await sum({ type: 'adjust', points: { lt: 0 } })) -
      // A cancelled coupon gave its points back.
      (await sum({ type: 'reverse', reverses: { is: { type: 'redeem' } } }));
    const expiredBefore = -(await sum({ type: 'expire' }));
    return Math.max(0, Math.min(balance, granted - spent - expiredBefore));
  }

  /** The client's account in the program, created on first use, with its row locked. */
  private async lockedAccount(
    tx: Prisma.TransactionClient,
    programId: string,
    customerId: string,
  ): Promise<{ id: string; balance: number }> {
    // ON CONFLICT: two first visits of a client at the same moment create one account
    // (an error would abort the whole transaction, so it cannot be caught and retried).
    await tx.$executeRaw`
      INSERT INTO loyalty_account (id, program_id, customer_id, updated_at)
      VALUES (${uuidV7()}::uuid, ${programId}::uuid, ${customerId}::uuid, now())
      ON CONFLICT (program_id, customer_id) DO NOTHING`;
    const [row] = await tx.$queryRaw<{ id: string; balance: number }[]>`
      SELECT id::text AS id, balance FROM loyalty_account
      WHERE program_id = ${programId}::uuid AND customer_id = ${customerId}::uuid
      FOR UPDATE`;
    if (!row) throw new Error('Loyalty account was not created');
    return row;
  }
}
