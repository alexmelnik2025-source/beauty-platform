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
import { PublicBookingService } from '../booking/public-booking.service';
import { addDays, instantToLocal, localToday } from '../scheduling/time';
import type {
  ClientWaitlistEntryResponse,
  ClientWaitlistResponse,
  PublicWaitlistEntryResponse,
  SalonWaitlistEntryResponse,
  SalonWaitlistResponse,
  WaitlistJoinedResponse,
  WaitlistOfferResponse,
} from './waitlist.responses';
import type {
  AcceptWaitlistOfferInput,
  ClientJoinWaitlistInput,
  JoinWaitlistInput,
  SalonWaitlistQuery,
} from './waitlist.schemas';
import {
  WAITLIST_FREE,
  WAITLIST_JOINED,
  WAITLIST_OFFER,
  type WaitlistNotification,
} from './waitlist-outbox';

const offerGone = (): AppException =>
  new AppException(
    HttpStatus.GONE,
    'OFFER_GONE',
    'This time is no longer held for you. Choose another time on the booking page',
  );

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
    private readonly booking: PublicBookingService,
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
      if (notified > 0) this.logger.log(`Offered a free time to ${notified} waiting clients`);
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
    await this.leave(entry);
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
        status: { in: ['waiting', 'notified', 'offered'] },
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
    await this.leave(entry);
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
      where: {
        locationId,
        status: { in: ['waiting', 'notified', 'offered'] },
        date: { gte: toDate(from) },
      },
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
    if (['waiting', 'notified', 'offered'].includes(entry.status)) {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, status: { in: ['waiting', 'notified', 'offered'] } },
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
      // An open offer's held time goes back to the booking page.
      if (entry.status === 'offered' && entry.offerAppointmentId) {
        await this.releaseHold(entry.offerAppointmentId);
      }
    }
    const fresh = await this.prisma.waitlistEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: SALON_INCLUDE,
    });
    return toSalon(fresh);
  }

  /**
   * Checks the waiting list from today on. Task 164: offers that were not answered in time are
   * let go (status missed). Then, for each salon, service, specialist and day where the booking
   * page shows a free time and no offer is open: when the salon holds times
   * (`waitlistHoldMinutes` > 0), the first client in the queue (who asked first) gets the earliest
   * free time held for those minutes and one email to take it or say no; otherwise (task 50)
   * everyone waiting gets one email with the free times. Returns how many clients were emailed.
   */
  async sweep(now = Date.now()): Promise<number> {
    await this.expireOffers(now);
    const entries = await this.prisma.waitlistEntry.findMany({
      where: {
        status: { in: ['waiting', 'offered'] },
        date: { gte: toDate(addDays(fromDate(new Date(now)), -1)) },
      },
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
    let offered = 0;
    for (const group of groups.values()) {
      // One open offer at a time: the next client waits for the answer or the 15 minutes.
      if (group.some((e) => e.status === 'offered')) continue;
      const first = group[0]!;
      const date = fromDate(first.date);
      if (!first.location.onlineBookingEnabled) continue;
      if (date < localToday(now, first.location.timezone)) continue;
      let slots: { start: string; time: string }[];
      try {
        const free = await this.availability.forPublic(
          first.location,
          { serviceId: first.serviceId, staffId: first.staffId ?? undefined, from: date, to: date },
          { now },
        );
        slots = free.slots;
      } catch {
        continue; // The service or specialist is gone: nothing will free up.
      }
      if (slots.length === 0) continue;
      const minutes = first.location.waitlistHoldMinutes;
      if (minutes > 0) {
        const entry = group.find((e) => e.status === 'waiting');
        if (entry && (await this.offer(entry, slots, minutes, now))) offered += 1;
      } else {
        offered += await this.tellAll(
          group,
          slots.map((s) => s.time).slice(0, TIMES_IN_EMAIL),
          now,
        );
      }
    }
    return offered;
  }

  /** Task 50 (the salon holds nothing): everyone waiting gets one email with the free times. */
  private async tellAll(group: WaitlistEntry[], times: string[], now: number): Promise<number> {
    let told = 0;
    for (const entry of group) {
      if (entry.status !== 'waiting') continue;
      await this.prisma.$transaction(async (tx) => {
        const marked = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, status: 'waiting' },
          data: { status: 'notified', notifiedAt: new Date(now) },
        });
        if (marked.count !== 1) return;
        await this.enqueue(tx, WAITLIST_FREE, { entryId: entry.id, times });
        told += 1;
      });
    }
    return told;
  }

  /** Holds the earliest of `slots` that is still free for `entry` and emails the offer. */
  private async offer(
    entry: WaitlistEntry & { location: Location },
    slots: { start: string; time: string }[],
    minutes: number,
    now: number,
  ): Promise<boolean> {
    for (const slot of slots) {
      const hold = await this.booking.holdForWaitlist(
        entry.location,
        {
          serviceId: entry.serviceId,
          staffId: entry.staffId ?? undefined,
          start: new Date(slot.start).getTime(),
        },
        { name: entry.name, email: entry.email, phone: entry.phone, locale: entry.locale },
        minutes,
      );
      if (!hold) continue;
      const done = await this.prisma.$transaction(async (tx) => {
        const marked = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, status: 'waiting' },
          data: {
            status: 'offered',
            notifiedAt: new Date(now),
            offerAppointmentId: hold.id,
            offerExpiresAt: new Date(Date.now() + minutes * 60_000),
          },
        });
        if (marked.count !== 1) return false;
        await this.enqueue(tx, WAITLIST_OFFER, { entryId: entry.id, time: slot.time });
        return true;
      });
      if (done) return true;
      // The client left the list meanwhile: let the time go.
      await this.releaseHold(hold.id);
      return false;
    }
    return false;
  }

  /** Offers whose time to answer has passed: the held time goes back, the entry is missed. */
  private async expireOffers(now: number): Promise<void> {
    const late = await this.prisma.waitlistEntry.findMany({
      where: { status: 'offered', offerExpiresAt: { lte: new Date(now) } },
      select: { id: true, offerAppointmentId: true },
      take: 500,
    });
    for (const e of late) {
      const changed = await this.prisma.waitlistEntry.updateMany({
        where: { id: e.id, status: 'offered' },
        data: { status: 'missed' },
      });
      if (changed.count === 1 && e.offerAppointmentId) await this.releaseHold(e.offerAppointmentId);
    }
  }

  /** The client leaves: a waiting entry or an open offer (its held time goes back). */
  private async leave(entry: Pick<WaitlistEntry, 'id' | 'status' | 'offerAppointmentId'>) {
    if (entry.status !== 'waiting' && entry.status !== 'offered') return;
    const changed = await this.prisma.waitlistEntry.updateMany({
      where: { id: entry.id, status: entry.status },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    if (changed.count === 1 && entry.status === 'offered' && entry.offerAppointmentId) {
      await this.releaseHold(entry.offerAppointmentId);
    }
  }

  private async releaseHold(appointmentId: string): Promise<void> {
    await this.prisma.appointment.updateMany({
      where: { id: appointmentId, status: 'held' },
      data: { status: 'expired' },
    });
  }

  /** Task 164: the offer behind the link in the email (no other clients, no salon notes). */
  async getOffer(token: string, now = Date.now()): Promise<WaitlistOfferResponse> {
    const entry = await this.byOfferToken(token);
    // Not answered in time: show it as missed straight away, the sweep lets the time go.
    if (
      entry.status === 'offered' &&
      entry.offerExpiresAt &&
      entry.offerExpiresAt.getTime() <= now
    ) {
      await this.expireOffers(now);
      return this.toOffer(await this.byOfferToken(token));
    }
    return this.toOffer(entry);
  }

  /**
   * Task 164: "Biorę ten termin". The visit is booked like after the email code (the link went to
   * the client's email) and the usual confirmation email with the manage link follows.
   */
  async acceptOffer(
    token: string,
    input: AcceptWaitlistOfferInput,
  ): Promise<WaitlistOfferResponse> {
    const entry = await this.byOfferToken(token);
    if (entry.status === 'booked') return this.toOffer(entry);
    if (entry.status !== 'offered' || !entry.offerAppointmentId) throw offerGone();
    try {
      await this.booking.confirmWaitlistHold(entry.offerAppointmentId, input.phone, async (tx) => {
        const marked = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, status: 'offered' },
          data: { status: 'booked', ...(input.phone ? { phone: input.phone } : {}) },
        });
        if (marked.count !== 1) throw offerGone();
      });
    } catch (error) {
      if (error instanceof AppException && error.code === 'HOLD_EXPIRED') throw offerGone();
      throw error;
    }
    return this.toOffer(await this.byOfferToken(token));
  }

  /** Task 164: "Nie, dziękuję" — the time goes to the next client in the queue. Twice is fine. */
  async declineOffer(token: string): Promise<WaitlistOfferResponse> {
    const entry = await this.byOfferToken(token);
    if (entry.status === 'offered') {
      const changed = await this.prisma.waitlistEntry.updateMany({
        where: { id: entry.id, status: 'offered' },
        data: { status: 'declined', cancelledAt: new Date() },
      });
      if (changed.count === 1 && entry.offerAppointmentId) {
        await this.releaseHold(entry.offerAppointmentId);
      }
    }
    return this.toOffer(await this.byOfferToken(token));
  }

  private async byOfferToken(token: string) {
    const entry = await this.prisma.waitlistEntry.findUnique({
      where: { offerTokenHash: hashToken(token) },
      include: {
        location: { select: { name: true, slug: true, timezone: true, currency: true } },
        service: { select: { name: true } },
        staff: { select: { displayName: true } },
      },
    });
    if (!entry) throw notFound('Offer');
    return entry;
  }

  private async toOffer(
    entry: Awaited<ReturnType<WaitlistService['byOfferToken']>>,
  ): Promise<WaitlistOfferResponse> {
    const visit = entry.offerAppointmentId
      ? await this.prisma.appointment.findUnique({
          where: { id: entry.offerAppointmentId },
          include: { staff: { select: { displayName: true } } },
        })
      : null;
    const local = visit ? instantToLocal(visit.startAt.getTime(), entry.location.timezone) : null;
    return {
      salon: { name: entry.location.name, slug: entry.location.slug },
      serviceId: entry.serviceId,
      serviceName: entry.service.name,
      staffName: visit?.staff.displayName ?? entry.staff?.displayName ?? null,
      date: local?.date ?? fromDate(entry.date),
      time: local?.time ?? null,
      durationMinutes: visit?.durationMinutes ?? null,
      priceGrosze: visit?.priceGrosze ?? null,
      currency: entry.location.currency,
      status: entry.status,
      expiresAt: entry.offerExpiresAt?.toISOString() ?? null,
      needsPhone: !entry.phone,
    };
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    type: typeof WAITLIST_JOINED | typeof WAITLIST_FREE | typeof WAITLIST_OFFER,
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
