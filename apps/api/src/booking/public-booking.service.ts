import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { generateToken, hashToken } from '../common/crypto';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { Appointment, Locale, Location, Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { instantToLocal } from '../scheduling/time';
import { AppointmentWriter, slotTaken, timesFor } from './appointment-writer';
import { renderCodeEmail } from './booking-templates';
import type {
  ClientRescheduleInput,
  ConfirmInput,
  CreateHoldInput,
  SendCodeInput,
} from './booking.schemas';
import { OutboxService } from './outbox.service';

export const HOLD_MINUTES = 10;
const CODE_MINUTES = 10;
const MAX_CODE_SENDS = 3;
const MAX_CODE_ATTEMPTS = 5;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const REMINDER_BEFORE_MS = 24 * 60 * MINUTE_MS;
const MANAGE_LINK_DAYS_AFTER_VISIT = 7;
/** Version of the booking terms text the client accepts. Change it when the text changes. */
export const BOOKING_TERMS_VERSION = '2026-10-draft';

interface HoldContact {
  name: string;
  phone: string;
  email: string;
  locale: Locale;
  marketingConsent: boolean;
  ip: string | null;
}

export interface HoldResponse {
  holdId: string;
  holdToken: string;
  expiresAt: string;
  start: string;
  end: string;
  date: string;
  time: string;
  staffId: string;
  staffName: string;
  serviceName: string;
  priceGrosze: number;
}

export interface PublicAppointmentResponse {
  id: string;
  status: Appointment['status'];
  start: string;
  end: string;
  /** Location-local date and time. */
  date: string;
  time: string;
  timezone: string;
  service: { id: string; name: string; durationMinutes: number; priceGrosze: number };
  staff: { id: string; displayName: string };
  salon: {
    name: string;
    slug: string;
    addressLine: string;
    city: string;
    postalCode: string;
    phone: string | null;
  };
  /** Until when the client can still move or cancel online. */
  changeableUntil: string;
  canChange: boolean;
}

const holdExpired = (): AppException =>
  new AppException(
    HttpStatus.GONE,
    'HOLD_EXPIRED',
    'The 10 minutes to confirm have passed. Choose the time again',
  );

const tooLate = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'TOO_LATE_TO_CHANGE',
    'It is too late to change this appointment online. Please call the salon',
  );

/**
 * Booking by clients without an account:
 * hold a slot (10 min) → email code → confirm → manage via a secret link.
 */
@Injectable()
export class PublicBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly writer: AppointmentWriter,
    private readonly outbox: OutboxService,
    private readonly mail: MailService,
    private readonly limiter: RateLimiterService,
  ) {}

  async findBookable(slug: string): Promise<Location> {
    const location = await this.prisma.location.findUnique({
      where: { slug: slug.toLowerCase() },
    });
    if (!location || !location.onlineBookingEnabled) throw notFound('Salon');
    return location;
  }

  // ── 1. Hold ───────────────────────────────────────────

  async createHold(slug: string, input: CreateHoldInput, ip: string): Promise<HoldResponse> {
    this.limiter.hit(`hold:ip:${ip}`, 5, HOLD_MINUTES * MINUTE_MS);
    const location = await this.findBookable(slug);

    // One active hold per browser: picking a new time releases the previous one.
    if (input.releaseHoldToken) {
      await this.prisma.appointment.updateMany({
        where: { holdTokenHash: hashToken(input.releaseHoldToken), status: 'held' },
        data: { status: 'expired' },
      });
    }

    const service = await this.prisma.service.findFirst({
      where: { id: input.serviceId, locationId: location.id, active: true },
    });
    if (!service) throw notFound('Service');

    const window = this.availability.publicWindow(location, Date.now());
    const free = await this.availability.staffFreeAt(
      location,
      service.id,
      input.staffId,
      input.start,
      window,
    );
    if (free.length === 0) throw slotTaken();

    const times = timesFor(input.start, service);
    const candidates = await this.leastBusyFirst(free, location, input.start);
    const holdToken = generateToken();
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * MINUTE_MS);

    // "Any staff member": try the least busy one, then the next if someone was faster.
    for (const staffId of candidates) {
      try {
        const hold = await this.writer.write(staffId, times, (tx) =>
          tx.appointment.create({
            data: {
              locationId: location.id,
              staffId,
              serviceId: service.id,
              status: 'held',
              source: 'online',
              ...times,
              holdExpiresAt: expiresAt,
              holdTokenHash: hashToken(holdToken),
              priceGrosze: service.priceGrosze,
              durationMinutes: service.durationMinutes,
              bufferMinutes: service.bufferMinutes,
            },
            include: { staff: true },
          }),
        );
        const local = instantToLocal(input.start, location.timezone);
        return {
          holdId: hold.id,
          holdToken,
          expiresAt: expiresAt.toISOString(),
          start: times.startAt.toISOString(),
          end: times.endAt.toISOString(),
          date: local.date,
          time: local.time,
          staffId,
          staffName: hold.staff.displayName,
          serviceName: service.name,
          priceGrosze: service.priceGrosze,
        };
      } catch (error) {
        if (error instanceof AppException && error.code === 'SLOT_TAKEN') continue;
        throw error;
      }
    }
    throw slotTaken();
  }

  /** Releases a hold the client no longer wants (e.g. closed the form). */
  async releaseHold(holdId: string, holdToken: string): Promise<void> {
    await this.prisma.appointment.updateMany({
      where: { id: holdId, holdTokenHash: hashToken(holdToken), status: 'held' },
      data: { status: 'expired' },
    });
  }

  // ── 2. Contact details and email code ─────────────────

  async sendCode(
    holdId: string,
    input: SendCodeInput,
    ip: string,
  ): Promise<{ codeExpiresAt: string }> {
    this.limiter.hit(`code:email:${input.email}`, 10, 60 * MINUTE_MS);
    const hold = await this.activeHold(holdId, input.holdToken);
    const existing = await this.prisma.verificationCode.findUnique({
      where: { appointmentId: hold.id },
    });
    if (existing && existing.sendCount >= MAX_CODE_SENDS) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_CODES',
        'The code was sent 3 times already. Choose the time again',
      );
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // A code never outlives its hold.
    const expiresAt = new Date(
      Math.min(Date.now() + CODE_MINUTES * MINUTE_MS, hold.holdExpiresAt!.getTime()),
    );
    const contact: HoldContact = {
      name: input.name,
      phone: input.phone,
      email: input.email,
      locale: input.locale,
      marketingConsent: input.marketingConsent,
      ip,
    };

    await this.prisma.$transaction([
      this.prisma.appointment.update({
        where: { id: hold.id },
        data: {
          holdContact: contact as unknown as Prisma.InputJsonValue,
          locale: input.locale,
        },
      }),
      // A new code replaces the previous one.
      this.prisma.verificationCode.upsert({
        where: { appointmentId: hold.id },
        create: {
          appointmentId: hold.id,
          email: input.email,
          codeHash: this.codeHash(hold.id, code),
          expiresAt,
        },
        update: {
          email: input.email,
          codeHash: this.codeHash(hold.id, code),
          expiresAt,
          attempts: 0,
          sendCount: { increment: 1 },
        },
      }),
    ]);

    const { subject, text } = renderCodeEmail(input.locale, code, hold.location.name);
    await this.mail.send({ to: input.email, subject, text });
    return { codeExpiresAt: expiresAt.toISOString() };
  }

  // ── 3. Confirm ────────────────────────────────────────

  async confirm(
    holdId: string,
    input: ConfirmInput,
  ): Promise<{ appointment: PublicAppointmentResponse; manageToken: string }> {
    const hold = await this.activeHold(holdId, input.holdToken);
    const code = await this.prisma.verificationCode.findUnique({
      where: { appointmentId: hold.id },
    });
    if (!code || !hold.holdContact) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'CODE_NOT_SENT', 'Request a code first');
    }
    if (code.expiresAt.getTime() <= Date.now()) {
      throw new AppException(HttpStatus.GONE, 'CODE_EXPIRED', 'The code has expired');
    }
    if (code.attempts >= MAX_CODE_ATTEMPTS) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many wrong codes. Request a new one',
      );
    }
    if (code.codeHash !== this.codeHash(hold.id, input.code)) {
      await this.prisma.verificationCode.update({
        where: { id: code.id },
        data: { attempts: { increment: 1 } },
      });
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_CODE', 'Wrong code', [
        { path: 'code', message: `${MAX_CODE_ATTEMPTS - code.attempts - 1} attempts left` },
      ]);
    }

    const contact = hold.holdContact as unknown as HoldContact;
    const manageToken = generateToken();

    const confirmed = await this.prisma.$transaction(async (tx) => {
      // Compared with the database clock: a hold that expired a millisecond ago is gone.
      const updated = await tx.$executeRaw`
        UPDATE appointment SET status = 'confirmed', hold_expires_at = NULL, hold_token_hash = NULL,
          hold_contact = NULL, updated_at = now()
        WHERE id = ${hold.id}::uuid AND status = 'held' AND hold_expires_at > now()`;
      if (updated !== 1) throw holdExpired();

      const customer = await tx.customer.upsert({
        where: {
          organizationId_email: {
            organizationId: hold.location.organizationId,
            email: contact.email,
          },
        },
        create: {
          organizationId: hold.location.organizationId,
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          locale: contact.locale,
        },
        update: { name: contact.name, phone: contact.phone, locale: contact.locale },
      });
      await tx.consentRecord.createMany({
        data: [
          {
            customerId: customer.id,
            type: 'booking_terms',
            version: BOOKING_TERMS_VERSION,
            granted: true,
            ip: contact.ip,
          },
          ...(contact.marketingConsent
            ? [
                {
                  customerId: customer.id,
                  type: 'marketing' as const,
                  version: BOOKING_TERMS_VERSION,
                  granted: true,
                  ip: contact.ip,
                },
              ]
            : []),
        ],
      });
      const appointment = await tx.appointment.update({
        where: { id: hold.id },
        data: { customerId: customer.id },
        include: { location: true, service: true, staff: true },
      });
      await tx.verificationCode.delete({ where: { id: code.id } });
      await tx.appointmentAccessToken.create({
        data: {
          appointmentId: appointment.id,
          tokenHash: hashToken(manageToken),
          expiresAt: new Date(
            appointment.startAt.getTime() + MANAGE_LINK_DAYS_AFTER_VISIT * DAY_MS,
          ),
        },
      });
      await this.writer.event(tx, appointment.id, 'confirmed', 'customer', null, {
        source: 'online',
      });
      await this.notifyBooked(tx, appointment, 'client_confirmation', 'salon_new_booking');
      return appointment;
    });

    return { appointment: this.toPublic(confirmed), manageToken };
  }

  // ── 4. Manage via the link from the email ─────────────

  async getByToken(token: string): Promise<PublicAppointmentResponse> {
    return this.toPublic(await this.byToken(token));
  }

  async cancelByToken(
    token: string,
    reason: string | undefined,
  ): Promise<PublicAppointmentResponse> {
    const appointment = await this.byToken(token);
    this.assertChangeable(appointment);
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.appointment.updateMany({
        where: { id: appointment.id, status: 'confirmed', version: appointment.version },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: 'customer',
          cancelReason: reason ?? null,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw tooLate();
      const version = appointment.version + 1;
      await this.writer.event(tx, appointment.id, 'cancelled', 'customer', null, {
        reason: reason ?? null,
      });
      await this.outbox.enqueue(tx, 'client_cancelled', { appointmentId: appointment.id, version });
      await this.outbox.enqueue(tx, 'salon_client_cancelled', {
        appointmentId: appointment.id,
        version,
        reason: reason ?? null,
      });
      return tx.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { location: true, service: true, staff: true },
      });
    });
    return this.toPublic(updated);
  }

  async rescheduleByToken(
    token: string,
    input: ClientRescheduleInput,
  ): Promise<PublicAppointmentResponse> {
    const appointment = await this.byToken(token);
    this.assertChangeable(appointment);
    const location = appointment.location;
    const window = this.availability.publicWindow(location, Date.now());
    const options = { excludeAppointmentId: appointment.id };

    let free = await this.availability.staffFreeAt(
      location,
      appointment.serviceId,
      input.staffId,
      input.start,
      window,
      options,
    );
    if (free.length === 0) throw slotTaken();
    // Keep the same staff member when possible.
    if (!input.staffId && free.includes(appointment.staffId)) free = [appointment.staffId];

    const times = timesFor(input.start, {
      durationMinutes: appointment.durationMinutes,
      bufferMinutes: appointment.bufferMinutes,
    });
    for (const staffId of free) {
      try {
        await this.writer.move(
          appointment,
          staffId,
          times,
          appointment.version,
          async (tx, version) => {
            await this.writer.event(tx, appointment.id, 'rescheduled', 'customer', null, {
              from: appointment.startAt.toISOString(),
              to: times.startAt.toISOString(),
              staffId,
            });
            const moved = { ...appointment, ...times, version };
            await this.notifyBooked(tx, moved, 'client_rescheduled', 'salon_client_rescheduled');
          },
        );
        return this.getByToken(token);
      } catch (error) {
        if (error instanceof AppException && error.code === 'SLOT_TAKEN') continue;
        throw error;
      }
    }
    throw slotTaken();
  }

  // ── Helpers ───────────────────────────────────────────

  private codeHash(holdId: string, code: string): string {
    return hashToken(`${holdId}:${code}`);
  }

  private async activeHold(holdId: string, holdToken: string) {
    const hold = await this.prisma.appointment.findFirst({
      where: { id: holdId, holdTokenHash: hashToken(holdToken) },
      include: { location: true },
    });
    if (!hold) throw notFound('Hold');
    if (
      hold.status !== 'held' ||
      !hold.holdExpiresAt ||
      hold.holdExpiresAt.getTime() <= Date.now()
    ) {
      throw holdExpired();
    }
    return hold;
  }

  private async byToken(token: string) {
    const access = await this.prisma.appointmentAccessToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { appointment: { include: { location: true, service: true, staff: true } } },
    });
    if (!access || access.expiresAt.getTime() <= Date.now()) throw notFound('Appointment');
    return access.appointment;
  }

  private changeableUntil(appointment: Pick<Appointment, 'startAt'>, location: Location): number {
    return appointment.startAt.getTime() - location.clientCancelDeadlineMinutes * MINUTE_MS;
  }

  private assertChangeable(appointment: Appointment & { location: Location }): void {
    if (
      appointment.status !== 'confirmed' ||
      Date.now() >= this.changeableUntil(appointment, appointment.location)
    ) {
      throw tooLate();
    }
  }

  /** Order candidates so the least busy staff member that day is tried first. */
  private async leastBusyFirst(
    staffIds: string[],
    location: Location,
    start: number,
  ): Promise<string[]> {
    if (staffIds.length <= 1) return staffIds;
    const dayStart = new Date(start - 12 * 60 * MINUTE_MS);
    const dayEnd = new Date(start + 12 * 60 * MINUTE_MS);
    const counts = await this.prisma.appointment.groupBy({
      by: ['staffId'],
      where: {
        locationId: location.id,
        staffId: { in: staffIds },
        status: 'confirmed',
        startAt: { gte: dayStart, lt: dayEnd },
      },
      _count: { _all: true },
    });
    const load = new Map(counts.map((c) => [c.staffId, c._count._all]));
    return [...staffIds].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0));
  }

  private async notifyBooked(
    tx: Prisma.TransactionClient,
    appointment: Pick<Appointment, 'id' | 'version' | 'startAt'>,
    clientKind: 'client_confirmation' | 'client_rescheduled',
    salonKind: 'salon_new_booking' | 'salon_client_rescheduled',
  ): Promise<void> {
    const payload = { appointmentId: appointment.id, version: appointment.version };
    await this.outbox.enqueue(tx, clientKind, payload);
    await this.outbox.enqueue(tx, salonKind, payload);
    const remindAt = appointment.startAt.getTime() - REMINDER_BEFORE_MS;
    if (remindAt > Date.now()) {
      await this.outbox.enqueue(tx, 'client_reminder', payload, { notBefore: new Date(remindAt) });
    }
  }

  toPublic(
    a: Appointment & {
      location: Location;
      service: { id: string; name: string };
      staff: { id: string; displayName: string };
    },
  ): PublicAppointmentResponse {
    const local = instantToLocal(a.startAt.getTime(), a.location.timezone);
    const until = this.changeableUntil(a, a.location);
    return {
      id: a.id,
      status: a.status,
      start: a.startAt.toISOString(),
      end: a.endAt.toISOString(),
      date: local.date,
      time: local.time,
      timezone: a.location.timezone,
      service: {
        id: a.service.id,
        name: a.service.name,
        durationMinutes: a.durationMinutes,
        priceGrosze: a.priceGrosze,
      },
      staff: { id: a.staff.id, displayName: a.staff.displayName },
      salon: {
        name: a.location.name,
        slug: a.location.slug,
        addressLine: a.location.addressLine,
        city: a.location.city,
        postalCode: a.location.postalCode,
        phone: a.location.phone,
      },
      changeableUntil: new Date(until).toISOString(),
      canChange: a.status === 'confirmed' && Date.now() < until,
    };
  }
}
