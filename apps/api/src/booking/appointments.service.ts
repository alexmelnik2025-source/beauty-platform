import { toWishes } from './visit-wishes';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, forbidden, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type {
  Appointment,
  AppointmentEvent,
  Customer,
  Location,
  LoyaltyCoupon,
  Prisma,
} from '../generated/prisma/client';
import { LoyaltyLedger } from '../loyalty/loyalty-ledger';
import type {
  ApplyVisitCouponInput,
  RemoveVisitCouponInput,
  SetPaidInput,
} from '../loyalty/loyalty.schemas';
import {
  visitCouponFields,
  visitNotChangeable,
  VisitCoupons,
  type CouponVisit,
} from '../loyalty/visit-coupons';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { addDays, instantToLocal, localToday, zonedToInstant } from '../scheduling/time';
import { AppointmentWriter, slotTaken, timesFor, versionConflict } from './appointment-writer';
import type {
  CancelInput,
  CreateAppointmentInput,
  ListAppointmentsQuery,
  RescheduleInput,
  SetStatusInput,
} from './booking.schemas';
import type {
  AppointmentDetailResponse,
  AppointmentResponse,
  VisitCouponsResponse,
} from './booking.responses';
import { HappyHoursService } from '../scheduling/happy-hours';
import { OutboxService } from './outbox.service';

export type {
  AppointmentDetailResponse,
  AppointmentResponse,
  VisitCouponsResponse,
} from './booking.responses';
import { offerFor } from '../scheduling/staff-prices';

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
 * their locations. Staff (masters): their own appointments, plus what their
 * permissions add (see organizations/permissions.ts).
 */
@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly availability: AvailabilityService,
    private readonly writer: AppointmentWriter,
    private readonly outbox: OutboxService,
    private readonly ledger: LoyaltyLedger,
    private readonly visitCoupons: VisitCoupons,
    private readonly happyHours: HappyHoursService,
  ) {}

  async list(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ListAppointmentsQuery,
  ): Promise<AppointmentResponse[]> {
    const location = await this.access.readable(m, locationId);
    const ownStaffIds = await this.visibleStaffIds(m, userId, locationId);
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
    const firsts = await this.firstCompleted(rows);
    const coupons = await this.visitCoupons.usedOn(this.prisma, rows);
    return rows.map((row) => this.toResponse(row, m, firsts, coupons));
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
    const firsts = await this.firstCompleted([appointment]);
    const coupons = await this.visitCoupons.usedOn(this.prisma, [appointment]);
    return {
      ...this.toResponse(appointment, m, firsts, coupons),
      history: events.map(toHistory),
    };
  }

  /** A booking entered by the salon (phone call, walk-in). Confirmed immediately. */
  async create(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: CreateAppointmentInput,
  ): Promise<AppointmentDetailResponse> {
    const location = await this.access.readable(m, locationId);
    await this.assertMayActFor(m, userId, locationId, input.staffId, 'createOwnAppointments');
    this.assertMayBookOutsideHours(m, input.allowOutsideHours);

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
    if (input.alreadyHappened) {
      // Marking "came" (and "paid") is a change to the visit, so it needs that right too.
      await this.assertMayActFor(m, userId, locationId, staff.id, 'changeOwnAppointments');
      this.assertRecentPast(location, input.start);
    } else {
      if (input.start < Date.now()) {
        throw new AppException(
          HttpStatus.BAD_REQUEST,
          'IN_THE_PAST',
          'This time has already passed',
        );
      }
      if (!input.allowOutsideHours) {
        await this.assertWithinHours(location, service.id, staff.id, input.start);
      }
    }

    const customer = await this.resolveCustomer(location, input);
    // The specialist's own price and duration of the service, if any (tasks 62, 70).
    const offer = await offerFor(this.prisma, staff.id, service);
    const times = timesFor(input.start, { ...service, durationMinutes: offer.durationMinutes });
    // The salon's happy hours (task 16) set the price for this staff member and time.
    const price = await this.happyHours.priceFor(this.prisma, location, {
      staffId: staff.id,
      serviceId: service.id,
      start: input.start,
      listPriceGrosze: offer.priceGrosze,
    });
    if (input.alreadyHappened) {
      const walkIn = await this.writer.write(staff.id, times, async (tx) => {
        // "Came" visits are outside the no-overlap constraint, so check them here (the staff
        // member's lock is held).
        const overlapping = await tx.appointment.count({
          where: {
            staffId: staff.id,
            status: 'completed',
            startAt: { lt: times.blockedUntil },
            blockedUntil: { gt: times.startAt },
          },
        });
        if (overlapping > 0) throw slotTaken();
        // Inserted as "confirmed" so the constraint also checks unmarked bookings, then "came".
        const appointment = await tx.appointment.create({
          data: {
            locationId,
            staffId: staff.id,
            serviceId: service.id,
            customerId: customer.id,
            status: 'confirmed',
            source: 'manual',
            ...times,
            ...price,
            durationMinutes: offer.durationMinutes,
            bufferMinutes: service.bufferMinutes,
            note: input.note ?? null,
            locale: customer.locale,
            createdByUserId: userId,
          },
        });
        const now = new Date();
        const done = await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: 'completed',
            version: { increment: 1 },
            ...(input.paid ? { paidAt: now, paidByUserId: userId } : {}),
          },
        });
        await this.writer.event(tx, appointment.id, 'created', 'staff', userId, {
          alreadyHappened: true,
        });
        await this.writer.event(tx, appointment.id, 'completed', 'staff', userId);
        if (input.paid) {
          const earned = await this.ledger.earnForVisit(
            tx,
            {
              id: done.id,
              organizationId: location.organizationId,
              serviceId: service.id,
              customerId: customer.id,
              priceGrosze: done.priceGrosze,
            },
            userId,
          );
          await this.writer.event(tx, appointment.id, 'paid', 'staff', userId, {
            loyaltyEarned: earned,
          });
        }
        // No emails: the client was there and the visit is over.
        return done;
      });
      return this.get(m, userId, locationId, walkIn.id);
    }
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
          ...price,
          durationMinutes: offer.durationMinutes,
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
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    await this.assertMayActFor(m, userId, locationId, staffId, 'changeOwnAppointments');
    this.assertMayBookOutsideHours(m, input.allowOutsideHours);
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
        appointment.durationMinutes,
      );
    }
    const times = timesFor(input.start, appointment);
    await this.writer.move(appointment, staffId, times, input.version, async (tx, version) => {
      await this.writer.event(tx, appointment.id, 'rescheduled', 'staff', userId, {
        from: appointment.startAt.toISOString(),
        to: times.startAt.toISOString(),
        staffId,
        fromStaffId: appointment.staffId,
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
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
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
      // The coupons were not used after all: the client gets them back.
      const couponsReturned = await this.visitCoupons.releaseForVisit(tx, appointment.id);
      await this.writer.event(tx, appointment.id, 'cancelled', 'staff', userId, {
        reason: input.reason,
        ...(couponsReturned > 0 ? { couponsReturned } : {}),
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
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    if (appointment.startAt.getTime() > Date.now()) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'NOT_STARTED',
        'The appointment has not started yet',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // A visit that is no longer "came" is no longer paid either: what it earned is taken back.
      const unpay = input.status !== 'completed' && appointment.paidAt !== null;
      const result = await tx.appointment.updateMany({
        where: {
          id: appointment.id,
          version: input.version,
          status: { in: ['confirmed', 'completed', 'no_show'] },
        },
        data: {
          status: input.status,
          version: { increment: 1 },
          ...(unpay ? { paidAt: null, paidByUserId: null } : {}),
        },
      });
      if (result.count !== 1) throw versionConflict();
      const taken = unpay ? await this.ledger.reverseForVisit(tx, appointment.id, userId) : 0;
      // "Did not come": the coupons were not used after all, the client gets them back.
      const couponsReturned =
        input.status === 'no_show'
          ? await this.visitCoupons.releaseForVisit(tx, appointment.id)
          : 0;
      const data = {
        ...(taken > 0 ? { loyaltyTakenBack: taken } : {}),
        ...(couponsReturned > 0 ? { couponsReturned } : {}),
      };
      await this.writer.event(
        tx,
        appointment.id,
        input.status,
        'staff',
        userId,
        Object.keys(data).length > 0 ? data : undefined,
      );
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  /**
   * "Paid" / "not paid (refund)" on a visit marked as "came". Until payments exist, this
   * mark is the payment confirmation that loyalty needs: paid → stamps or points by the
   * salon's rules, not paid → taken back. The visit's version makes double clicks harmless.
   */
  async setPaid(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: SetPaidInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    if (input.paid && appointment.status !== 'completed') {
      throw new AppException(
        HttpStatus.CONFLICT,
        'NOT_COMPLETED',
        'Only a visit marked as "came" can be paid',
      );
    }
    if (input.paid === (appointment.paidAt !== null)) {
      if (appointment.version !== input.version) throw versionConflict();
      return this.get(m, userId, locationId, appointmentId);
    }
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.appointment.updateMany({
        where: {
          id: appointment.id,
          version: input.version,
          paidAt: input.paid ? null : { not: null },
          ...(input.paid ? { status: 'completed' as const } : {}),
        },
        data: {
          paidAt: input.paid ? new Date() : null,
          paidByUserId: input.paid ? userId : null,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw versionConflict();
      if (input.paid) {
        const earned = await this.ledger.earnForVisit(
          tx,
          {
            id: appointment.id,
            organizationId: appointment.location.organizationId,
            serviceId: appointment.serviceId,
            customerId: appointment.customerId,
            // Earned on what the client actually paid, after coupons.
            priceGrosze: appointment.priceGrosze - appointment.discountGrosze,
          },
          userId,
        );
        await this.writer.event(tx, appointment.id, 'paid', 'staff', userId, {
          loyaltyEarned: earned,
        });
      } else {
        const taken = await this.ledger.reverseForVisit(tx, appointment.id, userId);
        await this.writer.event(tx, appointment.id, 'unpaid', 'staff', userId, {
          loyaltyTakenBack: taken,
        });
      }
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  // ── Loyalty coupons on a visit (task 10d) ─────────────

  /** Coupons used on the visit and the client's other unused coupons, with what each would take off. */
  async coupons(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
  ): Promise<VisitCouponsResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    return this.visitCoupons.overview(
      this.prisma,
      toCouponVisit(appointment, appointment.version),
      m.permissions.viewOwnEarnings,
    );
  }

  /**
   * Uses the client's coupon on a booked or "came" visit that is not paid yet. Whoever may
   * change the visit may do it; the salon's rules are checked here, not in the app.
   */
  async applyCoupon(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: ApplyVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    assertCouponsChangeable(appointment, input.version);
    const visit = toCouponVisit(appointment, input.version);
    await this.prisma.$transaction(async (tx) => {
      const coupon = await this.visitCoupons.findForVisit(tx, visit, input);
      const rules = await this.visitCoupons.rules(tx, visit.organizationId);
      const discountGrosze = await this.visitCoupons.apply(tx, visit, coupon, rules);
      await this.writer.event(tx, appointment.id, 'coupon_applied', 'staff', userId, {
        couponId: coupon.id,
        code: coupon.code,
        name: coupon.name,
        discountGrosze,
      });
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  /** Takes a coupon off a visit that is not paid yet; the client can use it again. */
  async removeCoupon(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    couponId: string,
    input: RemoveVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    assertCouponsChangeable(appointment, input.version);
    const visit = toCouponVisit(appointment, input.version);
    await this.prisma.$transaction(async (tx) => {
      const coupon = await this.visitCoupons.remove(tx, visit, couponId);
      await this.writer.event(tx, appointment.id, 'coupon_removed', 'staff', userId, {
        couponId: coupon.id,
        code: coupon.code,
        name: coupon.name,
      });
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  // ── The client's tier discount on a visit (task 10e) ──

  /**
   * Uses the client's tier discount (their tier in the salon now) on a booked or "came" visit
   * that is not paid yet, by the same rules as coupons: maximum share, combining discounts.
   */
  async applyTierDiscount(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: RemoveVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    assertCouponsChangeable(appointment, input.version);
    const visit = toCouponVisit(appointment, input.version);
    await this.prisma.$transaction(async (tx) => {
      const tier = await this.visitCoupons.applyTier(tx, visit);
      await this.writer.event(tx, appointment.id, 'tier_discount_applied', 'staff', userId, {
        name: tier.name,
        discountPercent: tier.discountPercent,
        discountGrosze: tier.discountGrosze,
      });
    });
    return this.get(m, userId, locationId, appointmentId);
  }

  /** Takes the tier discount off a visit that is not paid yet; the price goes back up. */
  async removeTierDiscount(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
    input: RemoveVisitCouponInput,
  ): Promise<AppointmentDetailResponse> {
    const appointment = await this.findVisible(m, userId, locationId, appointmentId);
    await this.assertMayActFor(m, userId, locationId, appointment.staffId, 'changeOwnAppointments');
    assertCouponsChangeable(appointment, input.version);
    const visit = toCouponVisit(appointment, input.version);
    await this.prisma.$transaction(async (tx) => {
      const removed = await this.visitCoupons.removeTier(tx, visit);
      await this.writer.event(tx, appointment.id, 'tier_discount_removed', 'staff', userId, {
        name: removed.name,
      });
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

  /** Whose appointments the caller may see: null = everyone's at the location. */
  private async visibleStaffIds(
    m: MembershipContext,
    userId: string,
    locationId: string,
  ): Promise<string[] | null> {
    if (m.permissions.viewAllAppointments) return null;
    return this.ownStaffIds(m, userId, locationId);
  }

  /**
   * Own appointments need `ownPermission`; someone else's need manageAllAppointments.
   * Owners and managers have both.
   */
  private async assertMayActFor(
    m: MembershipContext,
    userId: string,
    locationId: string,
    staffId: string,
    ownPermission: 'createOwnAppointments' | 'changeOwnAppointments',
  ): Promise<void> {
    const own = await this.ownStaffIds(m, userId, locationId);
    const isOwn = own === null || own.includes(staffId);
    const allowed = isOwn ? m.permissions[ownPermission] : m.permissions.manageAllAppointments;
    if (!allowed) throw forbidden();
  }

  /** A visit entered afterwards: started today or yesterday (salon time), not in the future. */
  private assertRecentPast(location: Location, start: number): void {
    const now = Date.now();
    if (start > now) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'NOT_STARTED',
        'The appointment has not started yet',
      );
    }
    const yesterday = addDays(localToday(now, location.timezone), -1);
    if (start < zonedToInstant(yesterday, 0, location.timezone)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'TOO_LONG_AGO',
        'A past visit can be entered for today or yesterday only',
      );
    }
  }

  private assertMayBookOutsideHours(m: MembershipContext, requested: boolean): void {
    if (requested && !m.permissions.bookOutsideHours) throw forbidden();
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
    const visible = await this.visibleStaffIds(m, userId, locationId);
    if (visible && !visible.includes(appointment.staffId)) throw notFound('Appointment');
    return appointment;
  }

  /** Within working hours and outside time off and other bookings (5-minute grid). */
  private async assertWithinHours(
    location: Location,
    serviceId: string,
    staffId: string,
    start: number,
    excludeAppointmentId?: string,
    keepDurationMinutes?: number,
  ): Promise<void> {
    const service = await this.prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
    // A moved visit keeps its own length; a new one takes the specialist's (task 70).
    const durationMinutes =
      keepDurationMinutes ?? (await offerFor(this.prisma, staffId, service)).durationMinutes;
    const times = timesFor(start, { ...service, durationMinutes });
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
      { stepMinutes: 5, excludeAppointmentId, durationMinutes: keepDurationMinutes },
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
    await this.outbox.enqueueReminder(tx, appointment);
  }

  /** Earliest completed visit per client, to mark first visits. */
  private async firstCompleted(rows: Appointment[]): Promise<Map<string, number>> {
    const ids = [
      ...new Set(rows.map((r) => r.customerId).filter((id): id is string => id !== null)),
    ];
    if (ids.length === 0) return new Map();
    const groups = await this.prisma.appointment.groupBy({
      by: ['customerId'],
      where: { customerId: { in: ids }, status: 'completed' },
      _min: { startAt: true },
    });
    return new Map(
      groups
        .filter((g) => g.customerId !== null && g._min.startAt !== null)
        .map((g) => [g.customerId!, g._min.startAt!.getTime()]),
    );
  }

  private toResponse(
    a: Loaded,
    m: MembershipContext,
    firstCompleted: Map<string, number>,
    coupons: Map<string, LoyaltyCoupon[]>,
  ): AppointmentResponse {
    const prices = m.permissions.viewOwnEarnings;
    const local = instantToLocal(a.startAt.getTime(), a.location.timezone);
    const contacts = m.permissions.viewClientContacts;
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
            phone: contacts ? a.customer.phone : null,
            email: contacts ? a.customer.email : null,
          }
        : null,
      priceGrosze: prices ? a.priceGrosze : null,
      discountGrosze: prices ? a.discountGrosze : null,
      coupons: (coupons.get(a.id) ?? []).map((c) => ({
        ...visitCouponFields(c),
        discountGrosze: prices ? (c.discountGrosze ?? 0) : null,
      })),
      tierDiscount:
        a.tierDiscountGrosze > 0
          ? {
              name: a.tierName ?? '',
              discountPercent: a.tierDiscountPercent ?? 0,
              discountGrosze: prices ? a.tierDiscountGrosze : null,
            }
          : null,
      staffChosenByClient: a.staffChosenByClient,
      firstVisit:
        a.customerId !== null &&
        (firstCompleted.get(a.customerId) ?? Infinity) >= a.startAt.getTime(),
      durationMinutes: a.durationMinutes,
      bufferMinutes: a.bufferMinutes,
      note: a.note,
      wishes: toWishes(a),
      holdExpiresAt: a.holdExpiresAt?.toISOString() ?? null,
      cancelledAt: a.cancelledAt?.toISOString() ?? null,
      cancelledBy: a.cancelledBy,
      cancelReason: a.cancelReason,
      paidAt: a.paidAt?.toISOString() ?? null,
      version: a.version,
      createdAt: a.createdAt.toISOString(),
    };
  }
}

function toHistory(e: AppointmentEvent): AppointmentDetailResponse['history'][number] {
  return { type: e.type, actor: e.actor, at: e.createdAt.toISOString(), data: e.data };
}

function toCouponVisit(a: Loaded, version: number): CouponVisit {
  return {
    id: a.id,
    organizationId: a.location.organizationId,
    serviceId: a.serviceId,
    customerId: a.customerId,
    priceGrosze: a.priceGrosze,
    tierDiscountGrosze: a.tierDiscountGrosze,
    tierName: a.tierName,
    tierDiscountPercent: a.tierDiscountPercent,
    version,
  };
}

/** Coupons change only on a booked or "came" visit that is not paid, at the version the caller read. */
function assertCouponsChangeable(a: Loaded, version: number): void {
  if (!['confirmed', 'completed'].includes(a.status) || a.paidAt !== null) {
    throw visitNotChangeable();
  }
  if (a.version !== version) throw versionConflict();
}
