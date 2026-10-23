import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, forbidden, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type {
  Appointment,
  AppointmentEvent,
  Customer,
  Location,
  Prisma,
} from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { addDays, instantToLocal, zonedToInstant } from '../scheduling/time';
import { AppointmentWriter, timesFor, versionConflict } from './appointment-writer';
import type {
  CancelInput,
  CreateAppointmentInput,
  ListAppointmentsQuery,
  RescheduleInput,
  SetStatusInput,
} from './booking.schemas';
import { OutboxService } from './outbox.service';

const MINUTE_MS = 60_000;
const REMINDER_BEFORE_MS = 24 * 60 * MINUTE_MS;

export interface AppointmentResponse {
  id: string;
  locationId: string;
  status: Appointment['status'];
  source: Appointment['source'];
  start: string;
  end: string;
  blockedUntil: string;
  /** Location-local date and time. */
  date: string;
  time: string;
  staff: { id: string; displayName: string };
  service: { id: string; name: string };
  customer: { id: string; name: string; phone: string; email: string | null } | null;
  priceGrosze: number;
  durationMinutes: number;
  bufferMinutes: number;
  note: string | null;
  holdExpiresAt: string | null;
  cancelledAt: string | null;
  cancelledBy: Appointment['cancelledBy'];
  cancelReason: string | null;
  version: number;
  createdAt: string;
}

export interface AppointmentDetailResponse extends AppointmentResponse {
  history: { type: string; actor: string; at: string; data: unknown }[];
}

type Loaded = Appointment & {
  location: Location;
  staff: { id: string; displayName: string; userId: string | null };
  service: { id: string; name: string };
  customer: Customer | null;
};

const include = {
  location: true,
  staff: { select: { id: true, displayName: true, userId: true } },
  service: { select: { id: true, name: true } },
  customer: true,
} as const;

const outsideHours = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'OUTSIDE_WORKING_HOURS',
    'This time is outside working hours or during time off. Send allowOutsideHours=true to book anyway',
  );

/**
 * Appointments as the salon sees them. Owners and managers: every appointment of
 * their locations. Staff (masters): only appointments of their own staff profile.
 */
@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly availability: AvailabilityService,
    private readonly writer: AppointmentWriter,
    private readonly outbox: OutboxService,
  ) {}

  async list(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ListAppointmentsQuery,
  ): Promise<AppointmentResponse[]> {
    const location = await this.access.readable(m, locationId);
    const ownStaffIds = await this.ownStaffIds(m, userId, locationId);
    const from = zonedToInstant(query.from, 0, location.timezone);
    const to = zonedToInstant(addDays(query.to, 1), 0, location.timezone);
    const rows = await this.prisma.appointment.findMany({
      where: {
        locationId,
        startAt: { gte: new Date(from), lt: new Date(to) },
        OR: [
          { status: { in: ['confirmed', 'completed', 'no_show', 'cancelled'] } },
          { status: 'held', holdExpiresAt: { gt: new Date() } },
        ],
        ...(query.staffId ? { staffId: query.staffId } : {}),
        ...(ownStaffIds ? { staffId: { in: ownStaffIds } } : {}),
      },
      include,
      orderBy: [{ startAt: 'asc' }, { staffId: 'asc' }],
    });
    return rows.map((row) => this.toResponse(row));
  }

  async get(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    const events = await this.prisma.appointmentEvent.findMany({
      where: { appointmentId },
      orderBy: { createdAt: 'asc' },
    });
    return { ...this.toResponse(appointment), history: events.map(toHistory) };
  }

  /** A booking entered by the salon (phone call, walk-in). Confirmed immediately. */
  async create(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: CreateAppointmentInput,
  ): Promise<AppointmentDetailResponse> {
    const location = await this.access.readable(m, locationId);
    await this.assertMayActFor(m, userId, locationId, input.staffId);

    const service = await this.prisma.service.findFirst({
      where: { id: input.serviceId, locationId, active: true },
    });
    if (!service) throw notFound('Service');
    const staff = await this.prisma.staffMember.findFirst({
      where: { id: input.staffId, locationId, active: true },
      include: { services: { where: { serviceId: service.id } } },
    });
    if (!staff) throw notFound('Staff member');
    if (staff.services.length === 0) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'STAFF_SERVICE_MISMATCH',
        'This staff member does not offer this service',
      );
    }
    if (input.start < Date.now()) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'IN_THE_PAST', 'This time has already passed');
    }
    if (!input.allowOutsideHours) {
      await this.assertWithinHours(location, service.id, staff.id, input.start);
    }

    const customer = await this.resolveCustomer(location, input);
    const times = timesFor(input.start, service);
    const created = await this.writer.write(staff.id, times, async (tx) => {
      const appointment = await tx.appointment.create({
        data: {
          locationId,
          staffId: staff.id,
          serviceId: service.id,
          customerId: customer.id,
          status: 'confirmed',
          source: 'manual',
          ...times,
          priceGrosze: service.priceGrosze,
          durationMinutes: service.durationMinutes,
          bufferMinutes: service.bufferMinutes,
          note: input.note ?? null,
          locale: customer.locale,
          createdByUserId: userId,
        },
      });
      await this.writer.event(tx, appointment.id, 'created', 'staff', userId, {
        outsideHours: input.allowOutsideHours,
      });
      await this.notifyClient(tx, appointment, 'client_confirmation');
      return appointment;
    });
    return this.get(m, userId, locationId, created.id);
  }

  async reschedule(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: RescheduleInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    const staffId = input.staffId ?? appointment.staffId;
    await this.assertMayActFor(m, userId, locationId, staffId);
    if (appointment.status !== 'confirmed') throw versionConflict();
    if (staffId !== appointment.staffId) {
      const offers = await this.prisma.staffService.count({
        where: { staffId, serviceId: appointment.serviceId, staff: { locationId, active: true } },
      });
      if (offers === 0) {
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          'STAFF_SERVICE_MISMATCH',
          'This staff member does not offer this service',
        );
      }
    }
    if (input.start < Date.now()) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'IN_THE_PAST', 'This time has already passed');
    }
    if (!input.allowOutsideHours) {
      await this.assertWithinHours(
        appointment.location,
        appointment.serviceId,
        staffId,
        input.start,
        appointment.id,
      );
    }
    const times = timesFor(input.start, appointment);
    await this.writer.move(appointment, staffId, times, input.version, async (tx, version) => {
      await this.writer.event(tx, appointment.id, 'rescheduled', 'staff', userId, {
        from: appointment.startAt.toISOString(),
        to: times.startAt.toISOString(),
        staffId,
      });
      await this.notifyClient(tx, { ...appointment, ...times, version }, 'client_rescheduled');
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  async cancel(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: CancelInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.appointment.updateMany({
        where: {
          id: appointment.id,
          version: input.version,
          status: { in: ['confirmed', 'held'] },
        },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: 'salon',
          cancelReason: input.reason,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw versionConflict();
      await this.writer.event(tx, appointment.id, 'cancelled', 'staff', userId, {
        reason: input.reason,
      });
      if (appointment.status === 'confirmed' && appointment.customer?.email) {
        await this.outbox.enqueue(tx, 'client_cancelled', {
          appointmentId: appointment.id,
          version: input.version + 1,
          reason: input.reason,
        });
      }
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  /** "Came" / "did not come" — only once the appointment has started. */
  async setStatus(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: SetStatusInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId);
    if (appointment.startAt.getTime() > Date.now()) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'NOT_STARTED',
        'The appointment has not started yet',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.appointment.updateMany({
        where: {
          id: appointment.id,
          version: input.version,
          status: { in: ['confirmed', 'completed', 'no_show'] },
        },
        data: { status: input.status, version: { increment: 1 } },
      });
      if (result.count !== 1) throw versionConflict();
      await this.writer.event(tx, appointment.id, input.status, 'staff', userId);
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  // ── Helpers ───────────────────────────────────────────

  /** Staff role: the staff profiles linked to the user at this location. Others: null (no limit). */
  private async ownStaffIds(
    m: MembershipContext,
    userId: string,
    locationId: string,
  ): Promise<string[] | null> {
    if (m.role !== 'staff') return null;
    const own = await this.prisma.staffMember.findMany({
      where: { locationId, userId },
      select: { id: true },
    });
    return own.map((s) => s.id);
  }

  private async assertMayActFor(
    m: MembershipContext,
    userId: string,
    locationId: string,
    staffId: string,
  ): Promise<void> {
    const own = await this.ownStaffIds(m, userId, locationId);
    if (own && !own.includes(staffId)) throw forbidden();
  }

  private async findVisible(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
  ): Promise<Loaded> {
    await this.access.readable(m, locationId);
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, locationId, status: { not: 'expired' } },
      include,
    });
    if (!appointment) throw notFound('Appointment');
    const own = await this.ownStaffIds(m, userId, locationId);
    if (own && !own.includes(appointment.staffId)) throw notFound('Appointment');
    return appointment;
  }

  /** Within working hours and outside time off and other bookings (5-minute grid). */
  private async assertWithinHours(
    location: Location,
    serviceId: string,
    staffId: string,
    start: number,
    excludeAppointmentId?: string,
  ): Promise<void> {
    const service = await this.prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
    const times = timesFor(start, service);
    const overlapping = await this.prisma.appointment.count({
      where: {
        staffId,
        startAt: { lt: times.blockedUntil },
        blockedUntil: { gt: times.startAt },
        OR: [{ status: 'confirmed' }, { status: 'held', holdExpiresAt: { gt: new Date() } }],
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
    });
    if (overlapping > 0) {
      throw new AppException(HttpStatus.CONFLICT, 'SLOT_TAKEN', 'This time is already booked');
    }
    const free = await this.availability.staffFreeAt(
      location,
      serviceId,
      staffId,
      start,
      this.availability.staffWindow(Date.now()),
      { stepMinutes: 5, excludeAppointmentId },
    );
    if (!free.includes(staffId)) throw outsideHours();
  }

  private async resolveCustomer(
    location: Location,
    input: CreateAppointmentInput,
  ): Promise<Customer> {
    if (input.customerId) {
      const existing = await this.prisma.customer.findFirst({
        where: { id: input.customerId, organizationId: location.organizationId },
      });
      if (!existing) throw notFound('Customer');
      return existing;
    }
    const c = input.customer!;
    if (c.email) {
      const customer = await this.prisma.customer.upsert({
        where: {
          organizationId_email: { organizationId: location.organizationId, email: c.email },
        },
        create: { organizationId: location.organizationId, ...c },
        update: { name: c.name, phone: c.phone },
      });
      return customer;
    }
    return this.prisma.customer.create({
      data: {
        organizationId: location.organizationId,
        name: c.name,
        phone: c.phone,
        locale: c.locale,
      },
    });
  }

  private async notifyClient(
    tx: Prisma.TransactionClient,
    appointment: Pick<Appointment, 'id' | 'version' | 'startAt' | 'customerId'>,
    kind: 'client_confirmation' | 'client_rescheduled',
  ): Promise<void> {
    if (!appointment.customerId) return;
    const payload = { appointmentId: appointment.id, version: appointment.version };
    // The worker skips the email when the client has no address.
    await this.outbox.enqueue(tx, kind, payload);
    const remindAt = appointment.startAt.getTime() - REMINDER_BEFORE_MS;
    if (remindAt > Date.now()) {
      await this.outbox.enqueue(tx, 'client_reminder', payload, { notBefore: new Date(remindAt) });
    }
  }

  private toResponse(a: Loaded): AppointmentResponse {
    const local = instantToLocal(a.startAt.getTime(), a.location.timezone);
    return {
      id: a.id,
      locationId: a.locationId,
      status: a.status,
      source: a.source,
      start: a.startAt.toISOString(),
      end: a.endAt.toISOString(),
      blockedUntil: a.blockedUntil.toISOString(),
      date: local.date,
      time: local.time,
      staff: { id: a.staff.id, displayName: a.staff.displayName },
      service: { id: a.service.id, name: a.service.name },
      customer: a.customer
        ? {
            id: a.customer.id,
            name: a.customer.name,
            phone: a.customer.phone,
            email: a.customer.email,
          }
        : null,
      priceGrosze: a.priceGrosze,
      durationMinutes: a.durationMinutes,
      bufferMinutes: a.bufferMinutes,
      note: a.note,
      holdExpiresAt: a.holdExpiresAt?.toISOString() ?? null,
      cancelledAt: a.cancelledAt?.toISOString() ?? null,
      cancelledBy: a.cancelledBy,
      cancelReason: a.cancelReason,
      version: a.version,
      createdAt: a.createdAt.toISOString(),
    };
  }
}

function toHistory(e: AppointmentEvent): {
  type: string;
  actor: string;
  at: string;
  data: unknown;
} {
  return { type: e.type, actor: e.actor, at: e.createdAt.toISOString(), data: e.data };
}
