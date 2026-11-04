import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppException, notFound } from '../common/app-exception';
import { responseSchema } from '../common/openapi';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Prisma } from '../generated/prisma/client';
import type { MailMessage } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { localDateSchema } from '../scheduling/scheduling.schemas';
import { addDays, instantToLocal, localToday } from '../scheduling/time';
import { renderWaitlistEmail } from './waitlist-templates';

/** Outbox row type: a time freed up somewhere — tells the waiting list. */
export const WAITLIST_FREED = 'waitlist_time_freed';

export interface WaitlistFreedNotification {
  locationId: string;
  staffId: string;
  /** Start of the freed time, ISO 8601. */
  startAt: string;
}

/** A client keeps at most this many days on waiting lists at once. */
export const MAX_WAITLIST = 10;
/** The email lists at most this many free times. */
const TIMES_IN_EMAIL = 6;

export const joinWaitlistSchema = z.strictObject({
  slug: z.string().min(1).max(100),
  serviceId: z.uuid(),
  /** Omitted = any specialist who does the service. */
  staffId: z.uuid().optional(),
  date: localDateSchema,
});
export type JoinWaitlistInput = z.infer<typeof joinWaitlistSchema>;

const entrySchema = z.strictObject({
  id: z.string(),
  date: z.string().describe('Local date at the salon, YYYY-MM-DD'),
  salon: z.strictObject({ slug: z.string(), name: z.string() }),
  service: z.strictObject({ id: z.string(), name: z.string() }),
  staff: z.strictObject({ id: z.string(), displayName: z.string() }).nullable(),
  /** When the "a time freed up" email went out; null = still waiting. */
  notifiedAt: z.string().datetime().nullable(),
});

export const waitlistEntrySchema = responseSchema('WaitlistEntry', entrySchema);
export const waitlistSchema = responseSchema(
  'Waitlist',
  z.strictObject({ items: z.array(entrySchema) }),
);
export type WaitlistEntryResponse = z.infer<typeof entrySchema>;

const include = {
  location: { select: { slug: true, name: true } },
  service: { select: { id: true, name: true } },
  staff: { select: { id: true, displayName: true } },
} as const;

/** The freed time of a visit before it is cancelled or moved (for `timeFreed`). */
export const freedBy = (visit: {
  id: string;
  locationId: string;
  staffId: string;
  startAt: Date;
}): { appointmentId: string; locationId: string; staffId: string; startAt: Date } => ({
  appointmentId: visit.id,
  locationId: visit.locationId,
  staffId: visit.staffId,
  startAt: visit.startAt,
});

const day = (date: string): Date => new Date(`${date}T00:00:00Z`);
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Waiting list (task 24). A signed-in client asks for a day (a service, one specialist or
 * anyone); when a visit that day is cancelled or moved away and a time is really free for
 * them, they get one email with the free times and a booking link. First come, first served.
 */
@Injectable()
export class WaitlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async join(
    client: { personId: string; email: string },
    input: JoinWaitlistInput,
  ): Promise<WaitlistEntryResponse> {
    const location = await this.prisma.location.findFirst({
      where: { slug: input.slug, onlineBookingEnabled: true },
    });
    if (!location) throw notFound('Location');
    const service = await this.prisma.service.findFirst({
      where: { id: input.serviceId, locationId: location.id, active: true },
      select: { id: true },
    });
    if (!service) throw notFound('Service');
    if (input.staffId) {
      const staff = await this.prisma.staffMember.findFirst({
        where: {
          id: input.staffId,
          locationId: location.id,
          active: true,
          services: { some: { serviceId: service.id } },
        },
        select: { id: true },
      });
      if (!staff) throw notFound('Staff member');
    }
    const today = localToday(Date.now(), location.timezone);
    if (input.date < today || input.date > addDays(today, location.bookingHorizonDays)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'DATE_OUT_OF_RANGE',
        'The day must be between today and the last day the salon takes bookings for',
      );
    }

    const person = await this.prisma.person.findUniqueOrThrow({
      where: { id: client.personId },
      select: { locale: true },
    });
    const key = {
      personId: client.personId,
      locationId: location.id,
      serviceId: service.id,
      staffId: input.staffId ?? null,
      date: day(input.date),
    };
    const existing = await this.prisma.waitlistEntry.findFirst({
      where: key,
      select: { id: true },
    });
    if (existing) {
      // Joining again re-arms the entry: one more email when a time frees up.
      const entry = await this.prisma.waitlistEntry.update({
        where: { id: existing.id },
        data: { notifiedAt: null, noticeId: null, email: client.email, locale: person.locale },
        include,
      });
      return toResponse(entry);
    }
    const active = await this.prisma.waitlistEntry.count({
      where: { personId: client.personId, date: { gte: day(today) } },
    });
    if (active >= MAX_WAITLIST) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'TOO_MANY_WAITLIST',
        `At most ${MAX_WAITLIST} days on waiting lists at once`,
      );
    }
    const entry = await this.prisma.waitlistEntry.create({
      data: { ...key, email: client.email, locale: person.locale },
      include,
    });
    return toResponse(entry);
  }

  /** The client's days still to come (yesterday's are gone), soonest first. */
  async list(client: { personId: string }): Promise<{ items: WaitlistEntryResponse[] }> {
    // A day ago in UTC covers every time zone's "today".
    const from = isoDay(new Date(Date.now() - 86_400_000));
    const entries = await this.prisma.waitlistEntry.findMany({
      where: { personId: client.personId, date: { gte: day(from) } },
      include: { ...include, location: { select: { slug: true, name: true, timezone: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      items: entries
        .filter((e) => isoDay(e.date) >= localToday(Date.now(), e.location.timezone))
        .map(toResponse),
    };
  }

  /** Leaving the list; an entry that is not the client's is simply not found. */
  async leave(client: { personId: string }, id: string): Promise<void> {
    const result = await this.prisma.waitlistEntry.deleteMany({
      where: { id, personId: client.personId },
    });
    if (result.count === 0) throw notFound('Waitlist entry');
  }

  /**
   * Called in the transaction that frees a time (a visit cancelled or moved away). Queues
   * one notice for the waiting list of that day, only when someone is still waiting.
   */
  async timeFreed(
    tx: Prisma.TransactionClient,
    freed: {
      appointmentId: string;
      version: number;
      locationId: string;
      staffId: string;
      startAt: Date;
    },
  ): Promise<void> {
    if (freed.startAt.getTime() <= Date.now()) return;
    const location = await tx.location.findUniqueOrThrow({
      where: { id: freed.locationId },
      select: { timezone: true },
    });
    const date = instantToLocal(freed.startAt.getTime(), location.timezone).date;
    const waiting = await tx.waitlistEntry.count({
      where: {
        locationId: freed.locationId,
        date: day(date),
        notifiedAt: null,
        OR: [{ staffId: null }, { staffId: freed.staffId }],
      },
    });
    if (waiting === 0) return;
    const payload: WaitlistFreedNotification = {
      locationId: freed.locationId,
      staffId: freed.staffId,
      startAt: freed.startAt.toISOString(),
    };
    await tx.notificationOutbox.createMany({
      data: [
        {
          type: WAITLIST_FREED,
          payload: payload as unknown as Prisma.InputJsonValue,
          dedupeKey: `${WAITLIST_FREED}:${freed.appointmentId}:${freed.version}`,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * The emails for one freed time, built when the queue sends them: only to entries that
   * still wait and for whom a time is really free now (their service, their specialist).
   * Each entry is marked with this row, so a retry of the same row sends it again but
   * another freed time does not.
   */
  async render(rowId: string, payload: WaitlistFreedNotification): Promise<MailMessage[] | null> {
    if (Date.parse(payload.startAt) <= Date.now()) return null;
    const location = await this.prisma.location.findUnique({ where: { id: payload.locationId } });
    if (!location?.onlineBookingEnabled) return null;
    const date = instantToLocal(Date.parse(payload.startAt), location.timezone).date;
    const entries = await this.prisma.waitlistEntry.findMany({
      where: {
        locationId: location.id,
        date: day(date),
        OR: [{ staffId: null }, { staffId: payload.staffId }],
        AND: [{ OR: [{ notifiedAt: null }, { noticeId: rowId }] }],
      },
      include: { service: true, staff: true },
      orderBy: { createdAt: 'asc' },
    });

    const messages: MailMessage[] = [];
    const notified: string[] = [];
    for (const entry of entries) {
      let times: string[];
      try {
        const free = await this.availability.forPublic(location, {
          serviceId: entry.serviceId,
          ...(entry.staffId ? { staffId: entry.staffId } : {}),
          from: date,
          to: date,
        });
        times = free.slots.map((s) => s.time);
      } catch {
        continue; // The service or specialist is no longer bookable online.
      }
      if (times.length === 0) continue;
      const params = new URLSearchParams({ service: entry.serviceId });
      if (entry.staffId) params.set('staff', entry.staffId);
      const link = `${this.config.APP_WEB_URL}/${entry.locale}/b/${encodeURIComponent(location.slug)}?${params.toString()}`;
      const { subject, text } = renderWaitlistEmail(entry.locale, {
        salonName: location.name,
        date,
        serviceName: entry.service.name,
        staffName: entry.staff?.displayName ?? null,
        times: times.slice(0, TIMES_IN_EMAIL),
        link,
      });
      messages.push({
        to: entry.email,
        subject,
        text,
        lang: entry.locale,
        senderName: location.name,
        ...(location.email ? { replyTo: location.email } : {}),
      });
      notified.push(entry.id);
    }
    if (notified.length === 0) return null;
    await this.prisma.waitlistEntry.updateMany({
      where: { id: { in: notified }, notifiedAt: null },
      data: { notifiedAt: new Date(), noticeId: rowId },
    });
    return messages;
  }
}

function toResponse(entry: {
  id: string;
  date: Date;
  notifiedAt: Date | null;
  location: { slug: string; name: string };
  service: { id: string; name: string };
  staff: { id: string; displayName: string } | null;
}): WaitlistEntryResponse {
  return {
    id: entry.id,
    date: isoDay(entry.date),
    salon: { slug: entry.location.slug, name: entry.location.name },
    service: { id: entry.service.id, name: entry.service.name },
    staff: entry.staff ? { id: entry.staff.id, displayName: entry.staff.displayName } : null,
    notifiedAt: entry.notifiedAt?.toISOString() ?? null,
  };
}
