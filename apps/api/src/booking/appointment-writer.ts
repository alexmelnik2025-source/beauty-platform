import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import type { Appointment, Prisma, Service } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

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

/**
 * Every kind of entry in a visit's history. The salon app translates each one
 * (test/locales.spec.ts checks all four languages).
 */
export const APPOINTMENT_EVENT_TYPES = [
  'created',
  'confirmed',
  'rescheduled',
  'cancelled',
  'completed',
  'no_show',
  'paid',
  'unpaid',
] as const;
export type AppointmentEventType = (typeof APPOINTMENT_EVENT_TYPES)[number];

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
 * Locks that queue writers of a staff member's time (appointments and time blocks).
 * - one staff member: shared lock on the location + exclusive lock on the staff member;
 * - the whole location (a salon-wide time block): exclusive lock on the location.
 * Without them, two transactions inserting overlapping rows can each wait for the
 * other inside the exclusion constraint (PostgreSQL aborts one as a deadlock after
 * 1 s), and a time block could slip in next to an appointment being written.
 * The order is always location → staff member, so the locks cannot deadlock.
 */
export async function lockStaff(tx: Prisma.TransactionClient, staffId: string): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock_shared(hashtextextended(location_id::text, 0))
    FROM staff_member WHERE id = ${staffId}::uuid`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${staffId}::uuid::text, 0))`;
}

export async function lockLocation(
  tx: Prisma.TransactionClient,
  locationId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${locationId}::uuid::text, 0))`;
}

/** True when a time block (the staff member's own or the whole location's) covers part of `times`. */
export async function blockedAt(
  tx: Prisma.TransactionClient,
  staffId: string,
  times: Pick<Times, 'startAt' | 'blockedUntil'>,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM time_block b JOIN staff_member s ON s.id = ${staffId}::uuid
    WHERE b.location_id = s.location_id
      AND (b.staff_id = s.id OR b.staff_id IS NULL)
      AND b.deleted_at IS NULL
      AND b.start_at < ${times.blockedUntil} AND b.end_at > ${times.startAt}`;
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * The only place that writes appointment times. The database guarantees that a
 * staff member's held/confirmed appointments never overlap (exclusion constraint
 * "appointment_no_overlap"); this class turns a violation into SLOT_TAKEN.
 */
@Injectable()
export class AppointmentWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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
        await lockStaff(tx, staffId);
        await this.releaseExpiredHolds(tx, staffId, times);
        if (await blockedAt(tx, staffId, times)) throw slotTaken();
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

  /** Records an appointment event and, in the same transaction, the in-app notifications. */
  async event(
    tx: Prisma.TransactionClient,
    appointmentId: string,
    type: AppointmentEventType,
    actor: 'customer' | 'staff' | 'system',
    actorUserId: string | null,
    data?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.appointmentEvent.create({
      data: { appointmentId, type, actor, actorUserId, data },
    });
    const previousStaffId =
      typeof data === 'object' && data !== null && 'fromStaffId' in data
        ? String((data as { fromStaffId: unknown }).fromStaffId)
        : undefined;
    await this.notifications.onAppointmentEvent(
      tx,
      appointmentId,
      type,
      actor === 'customer' ? null : actorUserId,
      previousStaffId,
    );
  }
}
