import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Location } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AvailabilityQuery } from './scheduling.schemas';
import {
  mergeSlots,
  type InstantRange,
  type LocalInterval,
  type Slot,
  type StaffSchedule,
} from './slots';
import { addDays, localToday, zonedToInstant } from './time';

export interface AvailabilityResponse {
  timezone: string;
  serviceId: string;
  durationMinutes: number;
  slots: Slot[];
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  /**
   * For staff booking on behalf of a client: no minimum lead time and no horizon,
   * only "not in the past".
   */
  async forStaff(
    m: MembershipContext,
    locationId: string,
    query: AvailabilityQuery,
    now = Date.now(),
  ): Promise<AvailabilityResponse> {
    const location = await this.access.readable(m, locationId);
    return this.compute(location, query, {
      earliestStart: now,
      latestStart: Number.POSITIVE_INFINITY,
    });
  }

  /** For the public booking page: the location's minimum lead time and booking horizon apply. */
  async forPublic(
    location: Location,
    query: AvailabilityQuery,
    now = Date.now(),
  ): Promise<AvailabilityResponse> {
    const horizonEnd = zonedToInstant(
      addDays(localToday(now, location.timezone), location.bookingHorizonDays + 1),
      0,
      location.timezone,
    );
    return this.compute(location, query, {
      earliestStart: now + location.minLeadMinutes * MINUTE_MS,
      latestStart: horizonEnd,
    });
  }

  private async compute(
    location: Location,
    query: AvailabilityQuery,
    window: { earliestStart: number; latestStart: number },
  ): Promise<AvailabilityResponse> {
    const service = await this.prisma.service.findFirst({
      where: { id: query.serviceId, locationId: location.id, active: true },
    });
    if (!service) throw notFound('Service');

    const staff = await this.prisma.staffMember.findMany({
      where: {
        locationId: location.id,
        active: true,
        services: { some: { serviceId: service.id } },
        ...(query.staffId ? { id: query.staffId } : {}),
      },
      select: { id: true },
    });
    if (query.staffId && staff.length === 0) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'STAFF_SERVICE_MISMATCH',
        'This staff member does not offer this service',
      );
    }
    const staffIds = staff.map((s) => s.id);

    // A day of margin on both sides covers time zones and appointments spanning midnight.
    const rangeStart = zonedToInstant(query.from, 0, location.timezone) - DAY_MS;
    const rangeEnd = zonedToInstant(addDays(query.to, 1), 0, location.timezone) + DAY_MS;

    const [weekly, overrides, timeOff] = await Promise.all([
      this.prisma.workingHours.findMany({ where: { staffId: { in: staffIds } } }),
      this.prisma.workingHoursOverride.findMany({
        where: {
          staffId: { in: staffIds },
          date: {
            gte: new Date(`${query.from}T00:00:00Z`),
            lte: new Date(`${query.to}T00:00:00Z`),
          },
        },
      }),
      this.prisma.timeOff.findMany({
        where: {
          staffId: { in: staffIds },
          startsAt: { lt: new Date(rangeEnd) },
          endsAt: { gt: new Date(rangeStart) },
        },
      }),
    ]);
    // Booked appointments join `busy` in task 4, from the same table that enforces
    // the no-double-booking constraint.

    const schedules: StaffSchedule[] = staffIds.map((staffId) => {
      const week = new Map<number, LocalInterval[]>();
      for (const row of weekly.filter((w) => w.staffId === staffId)) {
        week.set(row.weekday, [...(week.get(row.weekday) ?? []), row]);
      }
      const special = new Map<string, LocalInterval[]>();
      for (const row of overrides.filter((o) => o.staffId === staffId)) {
        const date = row.date.toISOString().slice(0, 10);
        special.set(date, [...(special.get(date) ?? []), row]);
      }
      const busy: InstantRange[] = timeOff
        .filter((t) => t.staffId === staffId)
        .map((t) => ({ start: t.startsAt.getTime(), end: t.endsAt.getTime() }));
      return { staffId, weekly: week, overrides: special, busy };
    });

    const slots = mergeSlots(schedules, {
      timeZone: location.timezone,
      from: query.from,
      to: query.to,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      stepMinutes: location.slotStepMinutes,
      ...window,
    });

    return {
      timezone: location.timezone,
      serviceId: service.id,
      durationMinutes: service.durationMinutes,
      slots,
    };
  }
}
