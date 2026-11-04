import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { generateToken, hashToken } from '../common/crypto';
import { RateLimiterService } from '../common/rate-limiter.service';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Location, Prisma, WaitlistEntry } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { addDays, localToday } from '../scheduling/time';
import type {
  ClientWaitlistEntryResponse,
  ClientWaitlistResponse,
  PublicWaitlistEntryResponse,
  SalonWaitlistEntryResponse,
  SalonWaitlistResponse,
  WaitlistJoinedResponse,
} from './waitlist.responses';
import type {
  ClientJoinWaitlistInput,
  JoinWaitlistInput,
  SalonWaitlistQuery,
} from './waitlist.schemas';

/** Outbox types (rendered by OutboxService.renderWaitlist). */
export const WAITLIST_JOINED = 'waitlist_joined';
export const WAITLIST_FREE = 'waitlist_free';

export interface WaitlistNotification {
  entryId: string;
  /** waitlist_free: the first free start times, "14:30" in the salon's time zone. */
  times?: string[];
}

/** One email may wait for at most this many days at one salon at the same time. */
export const MAX_WAITING_PER_EMAIL = 3;
const EVERY_MS = 60_000;
const TIMES_IN_EMAIL = 6;

const toDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
const fromDate = (date: Date): string => date.toISOString().slice(0, 10);

const SALON_INCLUDE = {
  service: { select: { name: true } },
  staff: { select: { displayName: true } },
} satisfies Prisma.WaitlistEntryInclude;

const CLIENT_INCLUDE = {
  location: { select: { name: true, slug: true, timezone: true } },
  service: { select: { name: true } },
  staff: { select: { displayName: true } },
} satisfies Prisma.WaitlistEntryInclude;

type ClientRow = Prisma.WaitlistEntryGetPayload<{ include: typeof CLIENT_INCLUDE }>;

function toClient(e: ClientRow): ClientWaitlistEntryResponse {
  return {
    id: e.id,
    salon: { name: e.location.name, slug: e.location.slug, timezone: e.location.timezone },
    serviceId: e.serviceId,
    serviceName: e.service.name,
    staffId: e.staffId,
    staffName: e.staff?.displayName ?? null,
    date: fromDate(e.date),
    status: e.status,
    notifiedAt: e.notifiedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

type SalonRow = Prisma.WaitlistEntryGetPayload<{ include: typeof SALON_INCLUDE }>;

function toSalon(e: SalonRow): SalonWaitlistEntryResponse {
  return {
    id: e.id,
    date: fromDate(e.date),
    serviceId: e.serviceId,
    serviceName: e.service.name,
    staffId: e.staffId,
    staffName: e.staff?.displayName ?? null,
    name: e.name,
    email: e.email,
    phone: e.phone,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    notifiedAt: e.notifiedAt?.toISOString() ?? null,
  };
}

/**
 * Task 50: the waiting list. A client asks to be told when a time becomes free on a day
 * that is full; every minute (on the server that runs the background workers) waiting
 * entries are checked against the same availability the booking page shows, and each
 * client gets one email when something frees up. Tests call `sweep` directly.
 */
@Injectable()
export class WaitlistService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Waitlist');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly limiter: RateLimiterService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.tick(), EVERY_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const notified = await this.sweep();
      if (notified > 0) this.logger.log(`Told ${notified} waiting clients about a free time`);
    } catch (error) {
      this.logger.error(`Sweep failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }

  async join(slug: string, input: JoinWaitlistInput, ip: string): Promise<WaitlistJoinedResponse> {
    this.limiter.hit(`waitlist:ip:${ip}`, 20, 60 * 60_000);
    this.limiter.hit(`waitlist:email:${input.email}`, 10, 60 * 60_000);
    const location = await this.bookable(slug);
    const service = await this.prisma.service.findFirst({
      where: { id: input.serviceId, locationId: location.id, active: true },
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
      });
      if (!staff) throw notFound('Staff member');
    }
    const today = localToday(Date.now(), location.timezone);
    if (input.date < today || input.date > addDays(today, location.bookingHorizonDays)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'WAITLIST_DATE',
        'Choose a day from today to the last day the salon takes bookings for',
      );
    }
    const free = await this.availability.forPublic(location, {
      serviceId: service.id,
      staffId: input.staffId,
      from: input.date,
      to: input.date,
    });
    if (free.slots.length > 0) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'SLOTS_AVAILABLE',
        'There are free times on this day: book one of them',
      );
    }

    const date = toDate(input.date);
    const same = await this.prisma.waitlistEntry.findFirst({
      where: {
        locationId: location.id,
        serviceId: service.id,
        staffId: input.staffId ?? null,
        date,
        email: input.email,
        status: 'waiting',
      },
    });
    if (same) return { date: input.date, status: 'waiting', alreadyWaiting: true };
    const waiting = await this.prisma.waitlistEntry.count({
      where: {
        locationId: location.id,
        email: input.email,
        status: 'waiting',
        date: { gte: toDate(today) },
      },
    });
    if (waiting >= MAX_WAITING_PER_EMAIL) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'WAITLIST_LIMIT',
        `You can wait for at most ${MAX_WAITING_PER_EMAIL} days at this salon at a time`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const entry = await tx.waitlistEntry.create({
        data: {
          locationId: location.id,
          serviceId: service.id,
          staffId: input.staffId ?? null,
          date,
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          locale: input.locale,
          // The link's token is made when the email is sent (only the email knows it).
          tokenHash: hashToken(generateToken()),
        },
      });
      await this.enqueue(tx, WAITLIST_JOINED, { entryId: entry.id });
    });
    return { date: input.date, status: 'waiting', alreadyWaiting: false };
  }

  async get(token: string): Promise<PublicWaitlistEntryResponse> {
    return this.toPublic(await this.byToken(token));
  }

  /** The client leaves the list from the link in the email. Leaving twice is fine. */
  async cancel(token: string): Promise<PublicWaitlistEntryResponse> {
    const entry = await this.byToken(token);
    if (entry.status === 'waiting') {
      await this.prisma.waitlistEntry.updateMany({
        where: { id: entry.id, status: 'waiting' },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    }
    return this.get(token);
  }

  /**
   * Task 51: the client app joins with the signed-in client's own (already confirmed) email.
   * Same rules and the same "you are on the list" email as the booking page.
   */
  joinAsClient(
    email: string,
    slug: string,
    input: ClientJoinWaitlistInput,
    ip: string,
  ): Promise<WaitlistJoinedResponse> {
    return this.join(slug, { ...input, email }, ip);
  }

  /**
   * Task 51: "Lista oczekujących" in the client app — the entries made with the client's email
   * in every salon, from today (in each salon's time zone) on; left/removed entries are not shown.
   */
  async listForClient(email: string, now = Date.now()): Promise<ClientWaitlistResponse> {
    const rows = await this.prisma.waitlistEntry.findMany({
      where: {
        email: email.toLowerCase(),
        status: { in: ['waiting', 'notified'] },
        // Time zones differ by at most a day; the exact check is per salon below.
        date: { gte: toDate(addDays(fromDate(new Date(now)), -1)) },
      },
      include: CLIENT_INCLUDE,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return {
      items: rows
        .filter((e) => fromDate(e.date) >= localToday(now, e.location.timezone))
        .map(toClient),
    };
  }

  /** Task 51: the client leaves one of their own lists. Leaving twice is fine. */
  async cancelForClient(email: string, entryId: string): Promise<ClientWaitlistEntryResponse> {
    const entry = await this.prisma.waitlistEntry.findFirst({
      where: { id: entryId, email: email.toLowerCase() },
    });
    if (!entry) throw notFound('Waiting list entry');
    await this.prisma.waitlistEntry.updateMany({
      where: { id: entry.id, status: 'waiting' },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    const fresh = await this.prisma.waitlistEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: CLIENT_INCLUDE,
    });
    return toClient(fresh);
  }

  /**
   * Task 50c: the location's list for owners and managers, from a day on (today in the salon's
   * time zone by default), by day and then by who asked first. Left/removed entries are not shown.
   */
  async listForSalon(
    m: MembershipContext,
    locationId: string,
    query: SalonWaitlistQuery,
  ): Promise<SalonWaitlistResponse> {
    const location = await this.access.writable(m, locationId);
    const from = query.from ?? localToday(Date.now(), location.timezone);
    const rows = await this.prisma.waitlistEntry.findMany({
      where: { locationId, status: { in: ['waiting', 'notified'] }, date: { gte: toDate(from) } },
      include: SALON_INCLUDE,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
    return { from, items: rows.map(toSalon) };
  }

  /** "Usuń z listy": the salon removes a client (no email). Removing twice is fine. */
  async removeBySalon(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    entryId: string,
  ): Promise<SalonWaitlistEntryResponse> {
    await this.access.writable(m, locationId);
    const entry = await this.prisma.waitlistEntry.findFirst({
      where: { id: entryId, locationId },
    });
    if (!entry) throw notFound('Waiting list entry');
    if (entry.status !== 'cancelled') {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, status: { not: 'cancelled' } },
          data: { status: 'cancelled', cancelledAt: new Date() },
        });
        if (changed.count === 0) return;
        await this.audit.record(
          {
            organizationId: m.organizationId,
            actorUserId,
            action: 'waitlist.removed',
            entityType: 'waitlist_entry',
            entityId: entry.id,
          },
          tx,
        );
      });
    }
    const fresh = await this.prisma.waitlistEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: SALON_INCLUDE,
    });
    return toSalon(fresh);
  }

  /**
   * Checks every waiting entry from today on: where the booking page now shows a free time,
   * the client is told once (status → notified). Returns how many clients were told.
   */
  async sweep(now = Date.now()): Promise<number> {
    const entries = await this.prisma.waitlistEntry.findMany({
      where: { status: 'waiting', date: { gte: toDate(addDays(fromDate(new Date(now)), -1)) } },
      include: { location: true },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });
    // One availability check per salon, service, specialist and day.
    const groups = new Map<string, (WaitlistEntry & { location: Location })[]>();
    for (const e of entries) {
      const key = `${e.locationId}|${e.serviceId}|${e.staffId ?? ''}|${fromDate(e.date)}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    let told = 0;
    for (const group of groups.values()) {
      const first = group[0]!;
      const date = fromDate(first.date);
      if (!first.location.onlineBookingEnabled) continue;
      if (date < localToday(now, first.location.timezone)) continue;
      let times: string[];
      try {
        const free = await this.availability.forPublic(
          first.location,
          { serviceId: first.serviceId, staffId: first.staffId ?? undefined, from: date, to: date },
          { now },
        );
        times = free.slots.map((s) => s.time);
      } catch {
        continue; // The service or specialist is gone: nothing will free up.
      }
      if (times.length === 0) continue;
      for (const entry of group) {
        await this.prisma.$transaction(async (tx) => {
          const marked = await tx.waitlistEntry.updateMany({
            where: { id: entry.id, status: 'waiting' },
            data: { status: 'notified', notifiedAt: new Date(now) },
          });
          if (marked.count !== 1) return;
          await this.enqueue(tx, WAITLIST_FREE, {
            entryId: entry.id,
            times: times.slice(0, TIMES_IN_EMAIL),
          });
          told += 1;
        });
      }
    }
    return told;
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    type: typeof WAITLIST_JOINED | typeof WAITLIST_FREE,
    payload: WaitlistNotification,
  ): Promise<void> {
    await tx.notificationOutbox.createMany({
      data: [
        {
          type,
          payload: payload as unknown as Prisma.InputJsonValue,
          dedupeKey: `${type}:${payload.entryId}`,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async bookable(slug: string): Promise<Location> {
    const location = await this.prisma.location.findUnique({ where: { slug: slug.toLowerCase() } });
    if (!location || !location.onlineBookingEnabled) throw notFound('Salon');
    return location;
  }

  private async byToken(token: string) {
    const entry = await this.prisma.waitlistEntry.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        location: { select: { name: true, slug: true } },
        service: { select: { name: true } },
        staff: { select: { displayName: true } },
      },
    });
    if (!entry) throw notFound('Waiting list entry');
    return entry;
  }

  private toPublic(entry: Awaited<ReturnType<WaitlistService['byToken']>>) {
    return {
      salon: { name: entry.location.name, slug: entry.location.slug },
      serviceId: entry.serviceId,
      serviceName: entry.service.name,
      staffId: entry.staffId,
      staffName: entry.staff?.displayName ?? null,
      date: fromDate(entry.date),
      status: entry.status,
    } satisfies PublicWaitlistEntryResponse;
  }
}
