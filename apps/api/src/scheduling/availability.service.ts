import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Location } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AvailabilityResponse } from './public.responses';
import type { AvailabilityQuery } from './scheduling.schemas';
import {
  mergeSlots,
  type InstantRange,
  type LocalInterval,
  type Slot,
  type StaffSchedule,
} from './slots';
import { offerOf } from './staff-offers';
import { addDays, instantToLocal, localToday, zonedToInstant } from './time';

export type { AvailabilityResponse } from './public.responses';

export interface BookingWindow {
  earliestStart: number;
  latestStart: number;
}

export interface ComputeOptions {
  /** Ignore this appointment's own time (used when moving it). */
  excludeAppointmentId?: string;
  /** Step between start times; defaults to the location's slot step. */
  stepMinutes?: number;
  now?: number;
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
    return this.compute(location, query, this.staffWindow(now), { now });
  }

  /** For the public booking page: the location's minimum lead time and booking horizon apply. */
  async forPublic(
    location: Location,
    query: AvailabilityQuery,
    options: ComputeOptions = {},
  ): Promise<AvailabilityResponse> {
    const now = options.now ?? Date.now();
    return this.compute(location, query, this.publicWindow(location, now), options);
  }

  staffWindow(now: number): BookingWindow {
    return { earliestStart: now, latestStart: Number.POSITIVE_INFINITY };
  }

  publicWindow(location: Location, now: number): BookingWindow {
    // With a 30-day horizon the last bookable day is today + 30.
    const horizonEnd = zonedToInstant(
      addDays(localToday(now, location.timezone), location.bookingHorizonDays + 1),
      0,
      location.timezone,
    );
    return { earliestStart: now + location.minLeadMinutes * MINUTE_MS, latestStart: horizonEnd };
  }

  /**
   * Who can take the service at exactly `start` (instant, ms)? Empty if nobody.
   * Uses the same calculation as the slot list, so what is offered is what can be booked.
   */
  async staffFreeAt(
    location: Location,
    serviceId: string,
    staffId: string | undefined,
    start: number,
    window: BookingWindow,
    options: ComputeOptions & { staffIds?: string[] } = {},
  ): Promise<string[]> {
    const date = instantToLocal(start, location.timezone).date;
    const result = await this.compute(
      location,
      {
        serviceId,
        staffId,
        staffIds: staffId ? undefined : options.staffIds,
        from: date,
        to: date,
      },
      window,
      options,
    );
    return result.slots.find((slot) => Date.parse(slot.start) === start)?.staffIds ?? [];
  }

  async compute(
    location: Location,
    query: AvailabilityQuery,
    window: BookingWindow,
    options: ComputeOptions = {},
  ): Promise<AvailabilityResponse> {
    const now = options.now ?? Date.now();
    const service = await this.prisma.service.findFirst({
      where: { id: query.serviceId, locationId: location.id, active: true },
    });
    if (!service) throw notFound('Service');

    const staff = await this.prisma.staffMember.findMany({
      where: {
        locationId: location.id,
        active: true,
        services: { some: { serviceId: service.id } },
        ...(query.staffId
          ? { id: query.staffId }
          : query.staffIds
            ? { id: { in: query.staffIds } }
            : {}),
      },
      select: {
        id: true,
        services: {
          where: { serviceId: service.id },
          select: { staffId: true, priceGrosze: true, durationMinutes: true },
        },
      },
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

    const [weekly, overrides, timeOff, appointments, blocks] = await Promise.all([
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
      // The same rows the no-double-booking constraint protects: confirmed bookings
      // and holds that have not expired yet. An expired hold is free time, even if
      // the cleanup job has not marked it yet.
      this.prisma.appointment.findMany({
        where: {
          staffId: { in: staffIds },
          startAt: { lt: new Date(rangeEnd) },
          blockedUntil: { gt: new Date(rangeStart) },
          OR: [{ status: 'confirmed' }, { status: 'held', holdExpiresAt: { gt: new Date(now) } }],
          ...(options.excludeAppointmentId ? { id: { not: options.excludeAppointmentId } } : {}),
        },
        select: { staffId: true, startAt: true, blockedUntil: true },
      }),
      // Time blocks of a staff member or of the whole location (staffId null).
      this.prisma.timeBlock.findMany({
        where: {
          locationId: location.id,
          deletedAt: null,
          OR: [{ staffId: { in: staffIds } }, { staffId: null }],
          startAt: { lt: new Date(rangeEnd) },
          endAt: { gt: new Date(rangeStart) },
        },
        select: { staffId: true, startAt: true, endAt: true },
      }),
    ]);

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
      const busy: InstantRange[] = [
        ...timeOff
          .filter((t) => t.staffId === staffId)
          .map((t) => ({ start: t.startsAt.getTime(), end: t.endsAt.getTime() })),
        ...appointments
          .filter((a) => a.staffId === staffId)
          .map((a) => ({ start: a.startAt.getTime(), end: a.blockedUntil.getTime() })),
        ...blocks
          .filter((b) => b.staffId === staffId || b.staffId === null)
          .map((b) => ({ start: b.startAt.getTime(), end: b.endAt.getTime() })),
      ];
      return { staffId, weekly: week, overrides: special, busy };
    });

    // Task 70: a specialist may take longer or shorter than the service says —
    // slots are counted per duration and merged by start time.
    const durationOf = new Map(
      staff.map((s) => [s.id, offerOf(service, s.services[0]!).durationMinutes]),
    );
    const byDuration = new Map<number, StaffSchedule[]>();
    for (const schedule of schedules) {
      const minutes = durationOf.get(schedule.staffId) ?? service.durationMinutes;
      byDuration.set(minutes, [...(byDuration.get(minutes) ?? []), schedule]);
    }
    const slots = mergeByStart(
      [...byDuration.entries()].map(([durationMinutes, group]) =>
        mergeSlots(group, {
          timeZone: location.timezone,
          from: query.from,
          to: query.to,
          durationMinutes,
          bufferMinutes: service.bufferMinutes,
          stepMinutes: options.stepMinutes ?? location.slotStepMinutes,
          ...window,
        }),
      ),
      staffIds,
    );

    return {
      timezone: location.timezone,
      serviceId: service.id,
      durationMinutes: service.durationMinutes,
      slots,
    };
  }
}

/** Slots of several duration groups as one list by start time; staff in the salon's order. */
function mergeByStart(lists: Slot[][], order: string[]): Slot[] {
  if (lists.length === 1) return lists[0]!;
  const rank = new Map(order.map((id, i) => [id, i]));
  const byStart = new Map<string, Slot>();
  for (const slot of lists.flat()) {
    const seen = byStart.get(slot.start);
    byStart.set(
      slot.start,
      seen ? { ...seen, staffIds: [...seen.staffIds, ...slot.staffIds] } : { ...slot },
    );
  }
  return [...byStart.values()]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((slot) => ({
      ...slot,
      staffIds: slot.staffIds.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
    }));
}
