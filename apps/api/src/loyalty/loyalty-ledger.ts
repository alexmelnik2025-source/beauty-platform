import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LoyaltyProgram, Prisma } from '../generated/prisma/client';

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
function uuidV7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

  /** The client's account in the program, created on first use, with its row locked. */
  private async lockedAccount(
    tx: Prisma.TransactionClient,
    programId: string,
    customerId: string,
  ): Promise<{ id: string }> {
    // ON CONFLICT: two first visits of a client at the same moment create one account
    // (an error would abort the whole transaction, so it cannot be caught and retried).
    await tx.$executeRaw`
      INSERT INTO loyalty_account (id, program_id, customer_id, updated_at)
      VALUES (${uuidV7()}::uuid, ${programId}::uuid, ${customerId}::uuid, now())
      ON CONFLICT (program_id, customer_id) DO NOTHING`;
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM loyalty_account
      WHERE program_id = ${programId}::uuid AND customer_id = ${customerId}::uuid
      FOR UPDATE`;
    if (!row) throw new Error('Loyalty account was not created');
    return row;
  }
}
