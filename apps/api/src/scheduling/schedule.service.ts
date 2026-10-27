import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';
import type { CreateTimeOffInput, OverrideInput, WeeklyHoursInput } from './scheduling.schemas';
import { formatClock, instantToLocal, localToday, parseLocalDateTime } from './time';
import type { TimeOffResponse, WorkingHoursResponse } from './scheduling.responses';

export type { TimeOffResponse, WorkingHoursResponse } from './scheduling.responses';

type IntervalResponse = WorkingHoursResponse['weekly'][number]['intervals'][number];

const MAX_TIME_OFF_DAYS = 366;

const toInterval = (row: { startMinute: number; endMinute: number }): IntervalResponse => ({
  start: formatClock(row.startMinute),
  end: formatClock(row.endMinute),
});

const dateValue = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
const dateString = (date: Date): string => date.toISOString().slice(0, 10);

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  async getWorkingHours(
    m: MembershipContext,
    locationId: string,
    staffId: string,
  ): Promise<WorkingHoursResponse> {
    const location = await this.access.readable(m, locationId);
    await this.catalog.findStaff(locationId, staffId);
    const [weekly, overrides] = await Promise.all([
      this.prisma.workingHours.findMany({
        where: { staffId },
        orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
      }),
      this.prisma.workingHoursOverride.findMany({
        where: { staffId, date: { gte: dateValue(localToday(Date.now(), location.timezone)) } },
        orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
      }),
    ]);

    const byWeekday = new Map<number, IntervalResponse[]>();
    for (const row of weekly) {
      byWeekday.set(row.weekday, [...(byWeekday.get(row.weekday) ?? []), toInterval(row)]);
    }
    const byDate = new Map<string, IntervalResponse[]>();
    for (const row of overrides) {
      const date = dateString(row.date);
      byDate.set(date, [...(byDate.get(date) ?? []), toInterval(row)]);
    }
    return {
      timezone: location.timezone,
      weekly: [...byWeekday].map(([weekday, intervals]) => ({ weekday, intervals })),
      overrides: [...byDate].map(([date, intervals]) => ({ date, intervals })),
    };
  }

  /** Replaces the whole weekly template. Existing appointments are never removed by this. */
  async setWeeklyHours(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    input: WeeklyHoursInput,
  ): Promise<WorkingHoursResponse> {
    await this.access.writable(m, locationId);
    await this.catalog.findStaff(locationId, staffId);
    const rows = input.days.flatMap((day) =>
      day.intervals.map((i) => ({
        staffId,
        weekday: day.weekday,
        startMinute: i.start,
        endMinute: i.end,
      })),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.workingHours.deleteMany({ where: { staffId } });
      await tx.workingHours.createMany({ data: rows });
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'staff.weekly_hours_set',
          entityType: 'staff_member',
          entityId: staffId,
        },
        tx,
      );
    });
    return this.getWorkingHours(m, locationId, staffId);
  }

  /** Special hours for one date (replace the weekly template on that date). */
  async setOverride(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    date: string,
    input: OverrideInput,
  ): Promise<WorkingHoursResponse> {
    await this.access.writable(m, locationId);
    await this.catalog.findStaff(locationId, staffId);
    await this.prisma.$transaction(async (tx) => {
      await tx.workingHoursOverride.deleteMany({ where: { staffId, date: dateValue(date) } });
      await tx.workingHoursOverride.createMany({
        data: input.intervals.map((i) => ({
          staffId,
          date: dateValue(date),
          startMinute: i.start,
          endMinute: i.end,
        })),
      });
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'staff.override_set',
          entityType: 'staff_member',
          entityId: staffId,
          metadata: { date },
        },
        tx,
      );
    });
    return this.getWorkingHours(m, locationId, staffId);
  }

  async removeOverride(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    date: string,
  ): Promise<void> {
    await this.access.writable(m, locationId);
    await this.catalog.findStaff(locationId, staffId);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.workingHoursOverride.deleteMany({
        where: { staffId, date: dateValue(date) },
      });
      if (result.count === 0) throw notFound('Special day');
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'staff.override_removed',
          entityType: 'staff_member',
          entityId: staffId,
          metadata: { date },
        },
        tx,
      );
    });
  }

  /** Time off that has not ended yet. */
  async listTimeOff(
    m: MembershipContext,
    locationId: string,
    staffId: string,
  ): Promise<TimeOffResponse[]> {
    const location = await this.access.readable(m, locationId);
    await this.catalog.findStaff(locationId, staffId);
    const rows = await this.prisma.timeOff.findMany({
      where: { staffId, endsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((row) => this.toTimeOff(row, location.timezone));
  }

  async addTimeOff(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    input: CreateTimeOffInput,
  ): Promise<TimeOffResponse> {
    const location = await this.access.writable(m, locationId);
    await this.catalog.findStaff(locationId, staffId);
    const startsAt = parseLocalDateTime(input.start, location.timezone);
    const endsAt = parseLocalDateTime(input.end, location.timezone);
    if (startsAt === null || endsAt === null || endsAt <= startsAt) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Invalid time off period',
        [{ path: 'end', message: 'end must be a valid local time after start' }],
      );
    }
    if (endsAt - startsAt > MAX_TIME_OFF_DAYS * 86_400_000) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Time off is too long', [
        { path: 'end', message: `at most ${MAX_TIME_OFF_DAYS} days` },
      ]);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.timeOff.create({
        data: { staffId, startsAt: new Date(startsAt), endsAt: new Date(endsAt), note: input.note },
      });
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'staff.time_off_added',
          entityType: 'time_off',
          entityId: created.id,
        },
        tx,
      );
      return created;
    });
    return this.toTimeOff(row, location.timezone);
  }

  async removeTimeOff(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    timeOffId: string,
  ): Promise<void> {
    await this.access.writable(m, locationId);
    await this.catalog.findStaff(locationId, staffId);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.timeOff.deleteMany({ where: { id: timeOffId, staffId } });
      if (result.count === 0) throw notFound('Time off');
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'staff.time_off_removed',
          entityType: 'time_off',
          entityId: timeOffId,
        },
        tx,
      );
    });
  }

  private toTimeOff(
    row: { id: string; startsAt: Date; endsAt: Date; note: string | null },
    timeZone: string,
  ): TimeOffResponse {
    const local = (d: Date) => {
      const l = instantToLocal(d.getTime(), timeZone);
      return `${l.date}T${l.time}`;
    };
    return {
      id: row.id,
      start: local(row.startsAt),
      end: local(row.endsAt),
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      note: row.note,
    };
  }
}
