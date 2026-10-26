import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { generateToken, hashToken } from '../common/crypto';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppointmentStatus, Locale, Person, Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientRescheduleInput } from '../booking/booking.schemas';
import {
  PublicBookingService,
  type PublicAppointmentResponse,
} from '../booking/public-booking.service';
import { renderClientCodeEmail } from './client-templates';
import type {
  ListClientAppointmentsInput,
  RequestClientCodeInput,
  VerifyClientCodeInput,
} from './client.schemas';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
export const CLIENT_SESSION_DAYS = 90;
const PAST_LIMIT = 50;

/** Statuses a client sees in "My visits" (never holds that were not confirmed). */
const VISIBLE: AppointmentStatus[] = ['confirmed', 'cancelled', 'completed', 'no_show'];

export interface PersonResponse {
  id: string;
  email: string;
  locale: Locale;
}

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

export interface ClientAppointmentResponse extends PublicAppointmentResponse {
  /** "Book again": same service and staff member. Null when the salon no longer takes it online. */
  bookAgain: { slug: string; serviceId: string; staffId: string | null } | null;
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
    await this.mail.send({ to: input.email, subject, text });
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

    const token = generateToken();
    const expiresAt = new Date(Date.now() + CLIENT_SESSION_DAYS * DAY_MS);
    const person = await this.prisma.$transaction(async (tx) => {
      // The code is single use, even when two requests race with it.
      const used = await tx.clientLoginCode.deleteMany({
        where: { id: stored.id, codeHash: stored.codeHash },
      });
      if (used.count !== 1) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'CODE_NOT_SENT', 'Request a code first');
      }
      const person = await tx.person.upsert({
        where: { email: input.email },
        create: { email: input.email, locale: input.locale ?? 'pl' },
        update: { lastSeenAt: new Date(), ...(input.locale ? { locale: input.locale } : {}) },
      });
      await tx.clientSession.create({
        data: {
          personId: person.id,
          clientType: input.clientType,
          tokenHash: hashToken(token),
          userAgent: userAgent?.slice(0, 300) ?? null,
          expiresAt,
        },
      });
      return person;
    });
    return { person: this.toPerson(person), token, expiresAt };
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
    return { items: items.map((a) => this.toClient(a)) };
  }

  async get(auth: ClientAuth, id: string): Promise<ClientAppointmentResponse> {
    return this.toClient(await this.mine(auth, id));
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

  // ── Helpers ───────────────────────────────────────────

  /** Appointments of salon customer cards with the person's confirmed email. */
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

  private toClient(a: LoadedAppointment): ClientAppointmentResponse {
    const bookable = a.location.onlineBookingEnabled && a.service.active;
    return {
      ...this.booking.toPublic(a),
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
