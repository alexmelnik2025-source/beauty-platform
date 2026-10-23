import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import type { Appointment, Prisma, Service } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MINUTE_MS = 60_000;

export const slotTaken = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'SLOT_TAKEN',
    'This time has just been taken. Choose another one',
  );

export const versionConflict = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    'The appointment was changed by someone else. Reload and try again',
  );

/** True when PostgreSQL rejected a write because of the no-overlap exclusion constraint. */
export function isOverlapViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const parts: string[] = [];
  let current: unknown = error;
  // Walk the error and its causes; driver errors are nested inside Prisma's.
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const e = current as Record<string, unknown>;
    parts.push(String(e.message ?? ''), String(e.code ?? ''), String(e.originalCode ?? ''));
    try {
      parts.push(JSON.stringify(e.meta ?? ''));
    } catch {
      // ignore unserialisable metadata
    }
    current = e.cause;
  }
  const text = parts.join(' ');
  return text.includes('23P01') || text.includes('appointment_no_overlap');
}

export interface Times {
  startAt: Date;
  endAt: Date;
  blockedUntil: Date;
}

export function timesFor(
  start: number,
  service: Pick<Service, 'durationMinutes' | 'bufferMinutes'>,
): Times {
  const end = start + service.durationMinutes * MINUTE_MS;
  return {
    startAt: new Date(start),
    endAt: new Date(end),
    blockedUntil: new Date(end + service.bufferMinutes * MINUTE_MS),
  };
}

/**
 * The only place that writes appointment times. The database guarantees that a
 * staff member's held/confirmed appointments never overlap (exclusion constraint
 * "appointment_no_overlap"); this class turns a violation into SLOT_TAKEN.
 */
@Injectable()
export class AppointmentWriter {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Holds whose 10 minutes are over still occupy their range in the constraint
   * until marked expired, so they are marked inside the same transaction first.
   */
  async releaseExpiredHolds(
    tx: Prisma.TransactionClient,
    staffId: string,
    times: Times,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE appointment SET status = 'expired', updated_at = now()
      WHERE staff_id = ${staffId}::uuid
        AND status = 'held'
        AND hold_expires_at <= now()
        AND tstzrange(start_at, blocked_until, '[)') && tstzrange(${times.startAt}, ${times.blockedUntil}, '[)')`;
  }

  /**
   * Runs `write` in a transaction after releasing expired holds; an overlap with
   * another booking becomes SLOT_TAKEN (409). The second of two simultaneous
   * requests waits for the first to commit and then gets the violation.
   */
  async write<T>(
    staffId: string,
    times: Times,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // One writer per staff member at a time. Without this, two transactions
        // inserting overlapping rows can each wait for the other inside the
        // exclusion constraint (PostgreSQL then aborts one as a deadlock after 1 s).
        // The constraint stays the guarantee; the lock only queues the writers.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${staffId}, 0))`;
        await this.releaseExpiredHolds(tx, staffId, times);
        return write(tx);
      });
    } catch (error) {
      if (error instanceof AppException) throw error;
      if (isOverlapViolation(error)) throw slotTaken();
      // Fallback in case the driver reports the violation in an unexpected shape.
      if (await this.overlapExists(staffId, times)) throw slotTaken();
      throw error;
    }
  }

  private async overlapExists(staffId: string, times: Times): Promise<boolean> {
    const count = await this.prisma.appointment.count({
      where: {
        staffId,
        startAt: { lt: times.blockedUntil },
        blockedUntil: { gt: times.startAt },
        OR: [{ status: 'confirmed' }, { status: 'held', holdExpiresAt: { gt: new Date() } }],
      },
    });
    return count > 0;
  }

  /** Moves an appointment (same row), checking the version the caller saw. */
  async move(
    appointment: Pick<Appointment, 'id' | 'version'>,
    staffId: string,
    times: Times,
    expectedVersion: number,
    after: (tx: Prisma.TransactionClient, newVersion: number) => Promise<void>,
  ): Promise<number> {
    return this.write(staffId, times, async (tx) => {
      const result = await tx.appointment.updateMany({
        where: { id: appointment.id, version: expectedVersion, status: 'confirmed' },
        data: { ...times, staffId, version: { increment: 1 } },
      });
      if (result.count !== 1) throw versionConflict();
      const newVersion = expectedVersion + 1;
      await after(tx, newVersion);
      return newVersion;
    });
  }

  event(
    tx: Prisma.TransactionClient,
    appointmentId: string,
    type: string,
    actor: 'customer' | 'staff' | 'system',
    actorUserId: string | null,
    data?: Prisma.InputJsonValue,
  ): Promise<unknown> {
    return tx.appointmentEvent.create({
      data: { appointmentId, type, actor, actorUserId, data },
    });
  }
}
