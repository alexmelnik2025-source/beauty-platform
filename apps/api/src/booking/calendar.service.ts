import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MembershipContext } from '../common/request-context';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, datesBetween, formatClock, isoWeekday, zonedToInstant } from '../scheduling/time';
import { AppointmentsService, type AppointmentResponse } from './appointments.service';
import type { ListAppointmentsQuery } from './booking.schemas';
import { TimeBlocksService, type TimeBlockResponse } from './time-blocks.service';

export interface CalendarStaff {
  id: string;
  displayName: string;
  /** Working hours per local date (special days already applied). Empty = day off. */
  days: { date: string; intervals: { start: string; end: string }[] }[];
}

export interface CalendarResponse {
  location: { id: string; name: string; timezone: string; slotStepMinutes: number };
  from: string;
  to: string;
  staff: CalendarStaff[];
  timeOff: { id: string; staffId: string; start: string; end: string; note: string | null }[];
  appointments: AppointmentResponse[];
  blocks: TimeBlockResponse[];
}

/**
 * Everything a calendar screen needs in one request. The response carries an
 * ETag: a calendar that refreshes every 30 s sends it back in If-None-Match and
 * gets 304 Not Modified (no body) while nothing it can see has changed.
 * Permissions apply as everywhere else: a staff member gets their own column,
 * plus everyone's with viewAllAppointments.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly appointments: AppointmentsService,
    private readonly blocks: TimeBlocksService,
  ) {}

  async get(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ListAppointmentsQuery,
  ): Promise<{ body: CalendarResponse; etag: string }> {
    const location = await this.access.readable(m, locationId);
    const onlyOwn = m.role === 'staff' && !m.permissions.viewAllAppointments;
    const staff = await this.prisma.staffMember.findMany({
      where: {
        locationId,
        active: true,
        ...(onlyOwn ? { userId } : {}),
        ...(query.staffId ? { id: query.staffId } : {}),
      },
      include: {
        workingHours: true,
        overrides: {
          where: {
            date: {
              gte: new Date(`${query.from}T00:00:00Z`),
              lte: new Date(`${query.to}T00:00:00Z`),
            },
          },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    });
    const staffIds = staff.map((s) => s.id);
    const rangeStart = new Date(zonedToInstant(query.from, 0, location.timezone));
    const rangeEnd = new Date(zonedToInstant(addDays(query.to, 1), 0, location.timezone));

    const [timeOff, appointments, blocks] = await Promise.all([
      this.prisma.timeOff.findMany({
        where: {
          staffId: { in: staffIds },
          startsAt: { lt: rangeEnd },
          endsAt: { gt: rangeStart },
        },
        orderBy: { startsAt: 'asc' },
      }),
      this.appointments.list(m, userId, locationId, query),
      this.blocks.list(m, userId, locationId, query),
    ]);

    const dates = datesBetween(query.from, query.to);
    const body: CalendarResponse = {
      location: {
        id: location.id,
        name: location.name,
        timezone: location.timezone,
        slotStepMinutes: location.slotStepMinutes,
      },
      from: query.from,
      to: query.to,
      staff: staff.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        days: dates.map((date) => {
          const special = s.overrides.filter((o) => o.date.toISOString().slice(0, 10) === date);
          const rows =
            special.length > 0
              ? special
              : s.workingHours.filter((w) => w.weekday === isoWeekday(date));
          return {
            date,
            intervals: [...rows]
              .sort((a, b) => a.startMinute - b.startMinute)
              .map((r) => ({ start: formatClock(r.startMinute), end: formatClock(r.endMinute) })),
          };
        }),
      })),
      timeOff: timeOff.map((t) => ({
        id: t.id,
        staffId: t.staffId,
        start: t.startsAt.toISOString(),
        end: t.endsAt.toISOString(),
        note: t.note,
      })),
      appointments,
      blocks,
    };
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
    return { body, etag };
  }
}
