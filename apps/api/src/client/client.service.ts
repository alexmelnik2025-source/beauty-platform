import type { VisitWishesInput } from '../booking/visit-wishes';
import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { hashToken } from '../common/crypto';
import { RateLimiterService } from '../common/rate-limiter.service';
import type {
  AppointmentStatus,
  Locale,
  LoyaltyCoupon,
  Person,
  Prisma,
} from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientRescheduleInput } from '../booking/booking.schemas';
import { AppointmentWriter } from '../booking/appointment-writer';
import { VisitPhotosService } from '../booking/visit-photos.service';
import type { VisitPhotoListResponse } from '../booking/visit-photos.responses';
import { PublicBookingService, tooLate } from '../booking/public-booking.service';
import type { VisitCouponsResponse } from '../booking/booking.responses';
import { VisitCoupons } from '../loyalty/visit-coupons';
import { createClientSession } from './client-session';
import type { ClientAppointmentResponse, PersonResponse } from './client.responses';
import { renderClientCodeEmail } from './client-templates';
import type {
  ClientApplyCouponInput,
  ListClientAppointmentsInput,
  RequestClientCodeInput,
  VerifyClientCodeInput,
} from './client.schemas';

const MINUTE_MS = 60_000;
const CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const PAST_LIMIT = 50;

/** Statuses a client sees in "My visits" (never holds that were not confirmed). */
const VISIBLE: AppointmentStatus[] = ['confirmed', 'cancelled', 'completed', 'no_show'];

export type { ClientAppointmentResponse, PersonResponse } from './client.responses';

export interface ClientSessionIssued {
  person: PersonResponse;
  token: string;
  expiresAt: Date;
}

export interface ClientAuth {
  personId: string;
  sessionId: string;
  email: string;
}

const include = {
  location: true,
  service: true,
  staff: true,
} satisfies Prisma.AppointmentInclude;

type LoadedAppointment = Prisma.AppointmentGetPayload<{ include: typeof include }>;

/**
 * "My visits": a client signs in with a one-time email code and sees their
 * appointments in every salon where they booked with that email.
 */
@Injectable()
export class ClientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly limiter: RateLimiterService,
    private readonly booking: PublicBookingService,
    private readonly visitCoupons: VisitCoupons,
    private readonly writer: AppointmentWriter,
    private readonly visitPhotos: VisitPhotosService,
  ) {}

  // ── Sign-in ───────────────────────────────────────────

  /** Always answers the same way, so nobody learns whether an address has visits. */
  async requestCode(input: RequestClientCodeInput): Promise<{ codeExpiresAt: string }> {
    this.limiter.hit(`client-code:email:${input.email}`, 5, 60 * MINUTE_MS);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + CODE_MINUTES * MINUTE_MS);
    const codeHash = this.codeHash(input.email, code);
    // A new code replaces the previous one.
    await this.prisma.clientLoginCode.upsert({
      where: { email: input.email },
      create: { email: input.email, codeHash, expiresAt },
      update: { codeHash, expiresAt, attempts: 0, createdAt: new Date() },
    });
    const { subject, text } = renderClientCodeEmail(input.locale, code);
    await this.mail.send({ to: input.email, subject, text, lang: input.locale });
    return { codeExpiresAt: expiresAt.toISOString() };
  }

  async verifyCode(
    input: VerifyClientCodeInput,
    userAgent: string | null,
  ): Promise<ClientSessionIssued> {
    const stored = await this.prisma.clientLoginCode.findUnique({ where: { email: input.email } });
    if (!stored) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'CODE_NOT_SENT', 'Request a code first');
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new AppException(HttpStatus.GONE, 'CODE_EXPIRED', 'The code has expired');
    }
    if (stored.attempts >= MAX_CODE_ATTEMPTS) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many wrong codes. Request a new one',
      );
    }
    if (stored.codeHash !== this.codeHash(input.email, input.code)) {
      await this.prisma.clientLoginCode.update({
        where: { id: stored.id },
        data: { attempts: { increment: 1 } },
      });
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_CODE', 'Wrong code', [
        { path: 'code', message: `${MAX_CODE_ATTEMPTS - stored.attempts - 1} attempts left` },
      ]);
    }

    const session = await this.prisma.$transaction(async (tx) => {
      // The code is single use, even when two requests race with it.
      const used = await tx.clientLoginCode.deleteMany({
        where: { id: stored.id, codeHash: stored.codeHash },
      });
      if (used.count !== 1) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'CODE_NOT_SENT', 'Request a code first');
      }
      return createClientSession(tx, {
        email: input.email,
        locale: input.locale,
        clientType: input.clientType,
        userAgent,
      });
    });
    return {
      person: this.toPerson(session.person),
      token: session.token,
      expiresAt: session.expiresAt,
    };
  }

  /** Resolves a session token; null when unknown or expired. */
  async authenticate(token: string): Promise<ClientAuth | null> {
    const session = await this.prisma.clientSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { person: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    // Touch at most once an hour to keep reads cheap.
    if (Date.now() - session.lastUsedAt.getTime() > 60 * MINUTE_MS) {
      await this.prisma.clientSession.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      });
    }
    return { personId: session.personId, sessionId: session.id, email: session.person.email };
  }

  async signOut(auth: ClientAuth): Promise<void> {
    await this.prisma.clientSession.deleteMany({ where: { id: auth.sessionId } });
  }

  async me(auth: ClientAuth): Promise<PersonResponse> {
    return this.toPerson(
      await this.prisma.person.findUniqueOrThrow({ where: { id: auth.personId } }),
    );
  }

  async updateMe(auth: ClientAuth, locale: Locale): Promise<PersonResponse> {
    return this.toPerson(
      await this.prisma.person.update({ where: { id: auth.personId }, data: { locale } }),
    );
  }

  // ── Visits ────────────────────────────────────────────

  async list(
    auth: ClientAuth,
    query: ListClientAppointmentsInput,
  ): Promise<{ items: ClientAppointmentResponse[] }> {
    const now = new Date();
    const mine = await this.mineWhere(auth);
    const items =
      query.scope === 'upcoming'
        ? await this.prisma.appointment.findMany({
            where: { ...mine, status: 'confirmed', endAt: { gt: now } },
            include,
            orderBy: { startAt: 'asc' },
          })
        : await this.prisma.appointment.findMany({
            where: {
              ...mine,
              status: { in: VISIBLE },
              NOT: { status: 'confirmed', endAt: { gt: now } },
            },
            include,
            orderBy: { startAt: 'desc' },
            take: PAST_LIMIT,
          });
    const coupons = await this.visitCoupons.usedOn(this.prisma, items);
    return { items: items.map((a) => this.toClient(a, coupons.get(a.id) ?? [])) };
  }

  async get(auth: ClientAuth, id: string): Promise<ClientAppointmentResponse> {
    const a = await this.mine(auth, id);
    const coupons = await this.visitCoupons.usedOn(this.prisma, [a]);
    return this.toClient(a, coupons.get(a.id) ?? []);
  }

  // ── Loyalty coupons on an upcoming visit (task 10d) ───

  /** The client's coupons in this salon: used on the visit, and the others with what each takes off. */
  async coupons(auth: ClientAuth, id: string): Promise<VisitCouponsResponse> {
    const a = await this.mine(auth, id);
    return this.visitCoupons.overview(this.prisma, couponVisit(a), true);
  }

  /**
   * The client picks a coupon for an upcoming visit, until the salon's deadline for changes
   * (like moving or cancelling). The salon's rules are checked on the server.
   */
  async applyCoupon(
    auth: ClientAuth,
    id: string,
    input: ClientApplyCouponInput,
  ): Promise<ClientAppointmentResponse> {
    const a = await this.changeable(auth, id);
    await this.prisma.$transaction(async (tx) => {
      const visit = couponVisit(a);
      const coupon = await this.visitCoupons.findForVisit(tx, visit, input);
      const rules = await this.visitCoupons.rules(tx, visit.organizationId);
      const discountGrosze = await this.visitCoupons.apply(tx, visit, coupon, rules);
      await this.writer.event(tx, a.id, 'coupon_applied', 'customer', null, {
        couponId: coupon.id,
        code: coupon.code,
        name: coupon.name,
        discountGrosze,
      });
    });
    return this.get(auth, id);
  }

  /** The client takes a coupon off an upcoming visit (until the deadline); it can be used again. */
  async removeCoupon(
    auth: ClientAuth,
    id: string,
    couponId: string,
  ): Promise<ClientAppointmentResponse> {
    const a = await this.changeable(auth, id);
    await this.prisma.$transaction(async (tx) => {
      const coupon = await this.visitCoupons.remove(tx, couponVisit(a), couponId);
      await this.writer.event(tx, a.id, 'coupon_removed', 'customer', null, {
        couponId: coupon.id,
        code: coupon.code,
        name: coupon.name,
      });
    });
    return this.get(auth, id);
  }

  async cancel(
    auth: ClientAuth,
    id: string,
    reason: string | undefined,
  ): Promise<ClientAppointmentResponse> {
    await this.booking.cancelAsClient(await this.mine(auth, id), reason);
    return this.get(auth, id);
  }

  async reschedule(
    auth: ClientAuth,
    id: string,
    input: ClientRescheduleInput,
  ): Promise<ClientAppointmentResponse> {
    await this.booking.rescheduleAsClient(await this.mine(auth, id), input);
    return this.get(auth, id);
  }

  /** Task 80: the client changes the wishes for an upcoming visit. */
  async updateWishes(
    auth: ClientAuth,
    id: string,
    input: VisitWishesInput,
  ): Promise<ClientAppointmentResponse> {
    await this.booking.updateWishes(await this.mine(auth, id), input);
    return this.get(auth, id);
  }

  // ── Helpers ───────────────────────────────────────────

  /** Appointments of salon customer cards with the person's confirmed email. */
  /** Task 80j: the example photos of one of my visits ("Pokaż, co chcesz"). */
  async photos(auth: ClientAuth, id: string): Promise<VisitPhotoListResponse> {
    return this.visitPhotos.listForVisit(await this.mine(auth, id));
  }

  /** Task 80j: removes one of my photos from my visit, until the visit starts. */
  async removePhoto(auth: ClientAuth, id: string, photoId: string): Promise<void> {
    await this.visitPhotos.removeFromVisit(await this.mine(auth, id), photoId);
  }

  private async mineWhere(auth: ClientAuth): Promise<Prisma.AppointmentWhereInput> {
    const customers = await this.prisma.customer.findMany({
      where: { email: auth.email },
      select: { id: true },
    });
    return { customerId: { in: customers.map((c) => c.id) } };
  }

  /** Someone else's appointment looks exactly like a missing one. */
  private async mine(auth: ClientAuth, id: string): Promise<LoadedAppointment> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, ...(await this.mineWhere(auth)), status: { in: VISIBLE } },
      include,
    });
    if (!appointment) throw notFound('Appointment');
    return appointment;
  }

  /** An upcoming visit the client may still change (the salon's deadline), else 409 TOO_LATE_TO_CHANGE. */
  private async changeable(auth: ClientAuth, id: string): Promise<LoadedAppointment> {
    const a = await this.mine(auth, id);
    if (!this.booking.toPublic(a).canChange) throw tooLate();
    return a;
  }

  private toClient(a: LoadedAppointment, coupons: LoyaltyCoupon[]): ClientAppointmentResponse {
    const bookable = a.location.onlineBookingEnabled && a.service.active;
    return {
      ...this.booking.toPublic(a),
      discountGrosze: a.discountGrosze,
      coupons: coupons.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        discountGrosze: c.discountGrosze ?? 0,
      })),
      bookAgain: bookable
        ? {
            slug: a.location.slug,
            serviceId: a.service.id,
            staffId: a.staff.active ? a.staff.id : null,
          }
        : null,
    };
  }

  private toPerson(person: Person): PersonResponse {
    return { id: person.id, email: person.email, locale: person.locale };
  }

  private codeHash(email: string, code: string): string {
    return hashToken(`client:${email}:${code}`);
  }
}

function couponVisit(a: LoadedAppointment) {
  return {
    id: a.id,
    organizationId: a.location.organizationId,
    serviceId: a.serviceId,
    customerId: a.customerId,
    priceGrosze: a.priceGrosze,
    tierDiscountGrosze: a.tierDiscountGrosze,
    tierName: a.tierName,
    tierDiscountPercent: a.tierDiscountPercent,
    version: a.version,
  };
}
