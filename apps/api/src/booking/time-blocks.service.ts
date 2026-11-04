import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppException, forbidden, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Location, Prisma, TimeBlock } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, instantToLocal, zonedToInstant } from '../scheduling/time';
import { lockLocation, lockStaff, versionConflict } from './appointment-writer';
import type { TimeBlockResponse, TimeBlockSeriesResponse } from './booking.responses';
import { listAppointmentsSchema } from './booking.schemas';

const MINUTE_MS = 60_000;
const MAX_BLOCK_MS = 31 * 24 * 60 * MINUTE_MS;

const fiveMinuteInstant = z.iso
  .datetime({ offset: true })
  .transform((value) => Date.parse(value))
  .refine((ms) => ms % (5 * MINUTE_MS) === 0, 'must be on a 5-minute mark');

/** Same range rules as the appointment list: local dates, at most 42 days. */
export const listBlocksSchema = listAppointmentsSchema;
export type ListBlocksQuery = z.infer<typeof listBlocksSchema>;

const blockRange = <T extends { start?: number; end?: number }>(b: T) =>
  b.start === undefined ||
  b.end === undefined ||
  (b.start < b.end && b.end - b.start <= MAX_BLOCK_MS);

export const createBlockSchema = z
  .object({
    /** null = the whole location (every staff member). */
    staffId: z.uuid().nullable(),
    start: fiveMinuteInstant,
    end: fiveMinuteInstant,
    reason: z.string().trim().max(200).optional(),
  })
  .refine(blockRange, 'end must be after start, at most 31 days later');
export type CreateBlockInput = z.infer<typeof createBlockSchema>;

/** The same time every week (launch task L4): the first block and how many weeks in a row. */
export const createBlockSeriesSchema = z
  .object({
    staffId: z.uuid().nullable(),
    start: fiveMinuteInstant,
    end: fiveMinuteInstant,
    reason: z.string().trim().max(200).optional(),
    weeks: z.number().int().min(2).max(26),
  })
  .refine(
    (b) => b.start < b.end && b.end - b.start <= 24 * 60 * MINUTE_MS,
    'end must be after start, at most a day later',
  );
export type CreateBlockSeriesInput = z.infer<typeof createBlockSeriesSchema>;

export const updateBlockSchema = z
  .object({
    version: z.number().int().min(1),
    staffId: z.uuid().nullable().optional(),
    start: fiveMinuteInstant.optional(),
    end: fiveMinuteInstant.optional(),
    reason: z.string().trim().max(200).nullable().optional(),
  })
  .refine(blockRange, 'end must be after start, at most 31 days later');
export type UpdateBlockInput = z.infer<typeof updateBlockSchema>;

export type { TimeBlockResponse, TimeBlockSeriesResponse } from './booking.responses';

const appointmentsInTheWay = (ids: string[]): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'APPOINTMENTS_IN_THE_WAY',
    'There are appointments in this time. Move or cancel them first',
    ids.map((id) => ({ path: 'appointmentId', message: id })),
  );

/**
 * Time blocks in the calendar. Owners and managers: any staff member or the whole
 * location. Staff: only their own time, and only with the blockOwnTime permission.
 * A block never overlaps a live appointment, and an appointment never lands on a
 * block (AppointmentWriter checks blocks under the same locks).
 */
@Injectable()
export class TimeBlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  async list(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ListBlocksQuery,
  ): Promise<TimeBlockResponse[]> {
    const location = await this.access.readable(m, locationId);
    const from = zonedToInstant(query.from, 0, location.timezone);
    const to = zonedToInstant(addDays(query.to, 1), 0, location.timezone);
    const own = await this.visibleStaffIds(m, userId, locationId);
    const rows = await this.prisma.timeBlock.findMany({
      where: {
        locationId,
        deletedAt: null,
        startAt: { lt: new Date(to) },
        endAt: { gt: new Date(from) },
        ...(query.staffId ? { OR: [{ staffId: query.staffId }, { staffId: null }] } : {}),
        ...(own ? { AND: [{ OR: [{ staffId: { in: own } }, { staffId: null }] }] } : {}),
      },
      orderBy: [{ startAt: 'asc' }],
    });
    return rows.map((row) => toResponse(row, location));
  }

  async create(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: CreateBlockInput,
  ): Promise<TimeBlockResponse> {
    const location = await this.access.readable(m, locationId);
    await this.assertMayBlock(m, userId, locationId, input.staffId);
    const block = await this.prisma.$transaction(async (tx) => {
      await this.lockAndCheck(tx, location, input.staffId, input.start, input.end);
      return tx.timeBlock.create({
        data: {
          locationId,
          staffId: input.staffId,
          startAt: new Date(input.start),
          endAt: new Date(input.end),
          reason: input.reason ?? null,
          createdByUserId: userId,
        },
      });
    });
    return toResponse(block, location);
  }

  /**
   * The same local time every week for `weeks` weeks (summer/winter time is followed). Weeks
   * where appointments are already in the way are left free and listed in skippedDates; when no
   * week is free, nothing is made (409 APPOINTMENTS_IN_THE_WAY).
   */
  async createSeries(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: CreateBlockSeriesInput,
  ): Promise<TimeBlockSeriesResponse> {
    const location = await this.access.readable(m, locationId);
    await this.assertMayBlock(m, userId, locationId, input.staffId);
    const tz = location.timezone;
    const first = instantToLocal(input.start, tz);
    const last = instantToLocal(input.end, tz);
    const seriesId = randomUUID();
    const skippedDates: string[] = [];
    const blocks = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, location, input.staffId);
      const made: TimeBlock[] = [];
      let firstInTheWay: string[] = [];
      for (let week = 0; week < input.weeks; week++) {
        const date = addDays(first.date, 7 * week);
        const start = zonedToInstant(date, first.minute, tz);
        const end = zonedToInstant(addDays(last.date, 7 * week), last.minute, tz);
        const inTheWay = await this.inTheWay(tx, location, input.staffId, start, end);
        if (inTheWay.length > 0) {
          skippedDates.push(date);
          if (firstInTheWay.length === 0) firstInTheWay = inTheWay;
          continue;
        }
        made.push(
          await tx.timeBlock.create({
            data: {
              locationId,
              staffId: input.staffId,
              startAt: new Date(start),
              endAt: new Date(end),
              reason: input.reason ?? null,
              seriesId,
              createdByUserId: userId,
            },
          }),
        );
      }
      if (made.length === 0) throw appointmentsInTheWay(firstInTheWay);
      return made;
    });
    return { seriesId, items: blocks.map((b) => toResponse(b, location)), skippedDates };
  }

  /** Removes the blocks of a series that have not ended yet; past ones stay as they were. */
  async removeSeries(
    m: MembershipContext,
    userId: string,
    locationId: string,
    seriesId: string,
  ): Promise<void> {
    await this.access.readable(m, locationId);
    const any = await this.prisma.timeBlock.findFirst({
      where: { seriesId, locationId, deletedAt: null },
      orderBy: { startAt: 'asc' },
    });
    if (!any) throw notFound('Time block');
    await this.findVisible(m, userId, locationId, any.id);
    await this.assertMayBlock(m, userId, locationId, any.staffId);
    await this.prisma.timeBlock.updateMany({
      where: { seriesId, locationId, deletedAt: null, endAt: { gt: new Date() } },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
  }

  async update(
    m: MembershipContext,
    userId: string,
    locationId: string,
    blockId: string,
    input: UpdateBlockInput,
  ): Promise<TimeBlockResponse> {
    const location = await this.access.readable(m, locationId);
    const current = await this.findVisible(m, userId, locationId, blockId);
    await this.assertMayBlock(m, userId, locationId, current.staffId);
    const staffId = input.staffId === undefined ? current.staffId : input.staffId;
    if (staffId !== current.staffId) await this.assertMayBlock(m, userId, locationId, staffId);
    const start = input.start ?? current.startAt.getTime();
    const end = input.end ?? current.endAt.getTime();
    if (!blockRange({ start, end })) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'end must be after start');
    }
    const block = await this.prisma.$transaction(async (tx) => {
      await this.lockAndCheck(tx, location, staffId, start, end);
      const result = await tx.timeBlock.updateMany({
        where: { id: blockId, version: input.version, deletedAt: null },
        data: {
          staffId,
          startAt: new Date(start),
          endAt: new Date(end),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw versionConflict();
      return tx.timeBlock.findUniqueOrThrow({ where: { id: blockId } });
    });
    return toResponse(block, location);
  }

  /** Kept as deleted, so calendars that ask "what changed" learn about it. */
  async remove(
    m: MembershipContext,
    userId: string,
    locationId: string,
    blockId: string,
  ): Promise<void> {
    await this.access.readable(m, locationId);
    const current = await this.findVisible(m, userId, locationId, blockId);
    await this.assertMayBlock(m, userId, locationId, current.staffId);
    const result = await this.prisma.timeBlock.updateMany({
      where: { id: blockId, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    if (result.count !== 1) throw notFound('Time block');
  }

  // ── Helpers ───────────────────────────────────────────

  /** Takes the calendar locks, then refuses if a live appointment is in the way. */
  private async lockAndCheck(
    tx: Prisma.TransactionClient,
    location: Location,
    staffId: string | null,
    start: number,
    end: number,
  ): Promise<void> {
    await this.lock(tx, location, staffId);
    const inTheWay = await this.inTheWay(tx, location, staffId, start, end);
    if (inTheWay.length > 0) throw appointmentsInTheWay(inTheWay);
  }

  /** The staff member's calendar lock, or the whole location's for a location-wide block. */
  private async lock(
    tx: Prisma.TransactionClient,
    location: Location,
    staffId: string | null,
  ): Promise<void> {
    if (staffId) {
      const staff = await tx.staffMember.findFirst({
        where: { id: staffId, locationId: location.id, active: true },
      });
      if (!staff) throw notFound('Staff member');
      await lockStaff(tx, staffId);
    } else {
      await lockLocation(tx, location.id);
    }
  }

  /** Live appointments (confirmed, or held and not expired) overlapping the time. */
  private async inTheWay(
    tx: Prisma.TransactionClient,
    location: Location,
    staffId: string | null,
    start: number,
    end: number,
  ): Promise<string[]> {
    const rows = await tx.appointment.findMany({
      where: {
        locationId: location.id,
        ...(staffId ? { staffId } : {}),
        startAt: { lt: new Date(end) },
        blockedUntil: { gt: new Date(start) },
        OR: [{ status: 'confirmed' }, { status: 'held', holdExpiresAt: { gt: new Date() } }],
      },
      select: { id: true },
      orderBy: { startAt: 'asc' },
      take: 20,
    });
    return rows.map((a) => a.id);
  }

  private async ownStaffIds(userId: string, locationId: string): Promise<string[]> {
    const own = await this.prisma.staffMember.findMany({
      where: { locationId, userId },
      select: { id: true },
    });
    return own.map((s) => s.id);
  }

  /** null = every block of the location is visible. */
  private async visibleStaffIds(
    m: MembershipContext,
    userId: string,
    locationId: string,
  ): Promise<string[] | null> {
    if (m.role !== 'staff' || m.permissions.viewAllAppointments) return null;
    return this.ownStaffIds(userId, locationId);
  }

  private async assertMayBlock(
    m: MembershipContext,
    userId: string,
    locationId: string,
    staffId: string | null,
  ): Promise<void> {
    if (m.role !== 'staff') {
      await this.access.writable(m, locationId);
      return;
    }
    const own = await this.ownStaffIds(userId, locationId);
    const mayBlockThis = staffId !== null && own.includes(staffId);
    if (!mayBlockThis || !m.permissions.blockOwnTime) throw forbidden();
  }

  private async findVisible(
    m: MembershipContext,
    userId: string,
    locationId: string,
    blockId: string,
  ): Promise<TimeBlock> {
    const block = await this.prisma.timeBlock.findFirst({
      where: { id: blockId, locationId, deletedAt: null },
    });
    if (!block) throw notFound('Time block');
    const visible = await this.visibleStaffIds(m, userId, locationId);
    if (visible && block.staffId !== null && !visible.includes(block.staffId)) {
      throw notFound('Time block');
    }
    return block;
  }
}

export function toResponse(b: TimeBlock, location: Location): TimeBlockResponse {
  const local = instantToLocal(b.startAt.getTime(), location.timezone);
  return {
    id: b.id,
    locationId: b.locationId,
    staffId: b.staffId,
    start: b.startAt.toISOString(),
    end: b.endAt.toISOString(),
    date: local.date,
    time: local.time,
    reason: b.reason,
    seriesId: b.seriesId,
    version: b.version,
    deleted: b.deletedAt !== null,
    updatedAt: b.updatedAt.toISOString(),
  };
}
