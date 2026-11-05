import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { hashToken } from '../common/crypto';
import type { MembershipContext } from '../common/request-context';
import type { Appointment, Prisma, ReviewSettings, VisitReview } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PublicReviewsResponse,
  ReviewSettingsResponse,
  SalonReviewsResponse,
  VisitReviewResponse,
} from './reviews.responses';
import type {
  ListReviewsQuery,
  UpdateReviewSettingsInput,
  WriteReviewInput,
} from './reviews.schemas';

const DAY_MS = 86_400_000;
/** A visit can be reviewed (and the review changed) until this many days after it ends. */
export const REVIEW_DAYS = 30;
const PAGE = 20;

/** Off until the salon saves its own settings. */
export const DEFAULT_REVIEW_SETTINGS: Pick<ReviewSettings, 'enabled' | 'requestHours'> = {
  enabled: false,
  requestHours: 2,
};

type ReviewableVisit = Pick<Appointment, 'id' | 'locationId' | 'staffId' | 'status' | 'endAt'> & {
  customerId: string | null;
};

/**
 * Task 165b: reviews after the visit. The salon switches them on; a client rates the
 * specialist (1–5) with optional words, once per visit that took place, until 30 days after
 * it — and may change the review in that time. The salon page shows reviews without any
 * client data; the cabinet shows them with the client's name to those who see the visit.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
  ) {}

  // ── Settings (owners and managers) ───────────────────

  async getSettings(m: MembershipContext, locationId: string): Promise<ReviewSettingsResponse> {
    await this.access.readable(m, locationId);
    return toSettings(await this.prisma.reviewSettings.findUnique({ where: { locationId } }));
  }

  async updateSettings(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    input: UpdateReviewSettingsInput,
  ): Promise<ReviewSettingsResponse> {
    await this.access.writable(m, locationId);
    const { version, ...data } = input;
    const saved = await this.prisma.$transaction(async (tx) => {
      const current = await tx.reviewSettings.findUnique({ where: { locationId } });
      if ((current?.version ?? 0) !== version) throw conflict();
      let row: ReviewSettings;
      if (current) {
        const result = await tx.reviewSettings.updateMany({
          where: { locationId, version },
          data: { ...data, version: { increment: 1 } },
        });
        if (result.count !== 1) throw conflict();
        row = await tx.reviewSettings.findUniqueOrThrow({ where: { locationId } });
      } else {
        row = await tx.reviewSettings.create({ data: { locationId, ...data } }).catch(() => {
          throw conflict();
        });
      }
      const fields = (Object.keys(data) as (keyof typeof data)[]).filter(
        (k) => (current ?? DEFAULT_REVIEW_SETTINGS)[k] !== data[k],
      );
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'location.review_settings_set',
          entityType: 'location',
          entityId: locationId,
          metadata: { fields },
        },
        tx,
      );
      return row;
    });
    return toSettings(saved);
  }

  // ── The cabinet ──────────────────────────────────────

  /**
   * Reviews of the location, newest first. Staff without "all appointments" see only reviews
   * of their own visits (like their calendar).
   */
  async listForSalon(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ListReviewsQuery,
  ): Promise<SalonReviewsResponse> {
    await this.access.readable(m, locationId);
    const settings = await this.settings(locationId);
    const where: Prisma.VisitReviewWhereInput = {
      locationId,
      ...(query.staffId ? { staffId: query.staffId } : {}),
      ...(m.role === 'staff' && !m.permissions.viewAllAppointments ? { staff: { userId } } : {}),
    };
    const [summary, rows] = await Promise.all([
      this.prisma.visitReview.aggregate({ where, _count: true, _avg: { rating: true } }),
      this.prisma.visitReview.findMany({
        where: { ...where, ...(query.before ? { id: { lt: query.before } } : {}) },
        include: {
          staff: { select: { displayName: true } },
          appointment: {
            select: {
              startAt: true,
              service: { select: { name: true } },
              customer: { select: { id: true, name: true, anonymizedAt: true } },
            },
          },
        },
        orderBy: { id: 'desc' },
        take: PAGE + 1,
      }),
    ]);
    const page = rows.slice(0, PAGE);
    return {
      enabled: settings.enabled,
      count: summary._count,
      average: average(summary._avg.rating),
      items: page.map((r) => {
        const customer = r.appointment.customer;
        const named = customer && !customer.anonymizedAt ? customer : null;
        return {
          id: r.id,
          rating: r.rating,
          text: r.text,
          staffId: r.staffId,
          staffName: r.staff.displayName,
          serviceName: r.appointment.service.name,
          appointmentId: r.appointmentId,
          visitStartAt: r.appointment.startAt.toISOString(),
          customerId: named?.id ?? null,
          customerName: named?.name ?? null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
      nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null,
    };
  }

  // ── The salon page ───────────────────────────────────

  /** Only salons open for online booking; nothing while the salon does not collect reviews. */
  async listPublic(slug: string, query: ListReviewsQuery): Promise<PublicReviewsResponse> {
    const location = await this.prisma.location.findUnique({
      where: { slug: slug.toLowerCase() },
      select: { id: true, onlineBookingEnabled: true },
    });
    if (!location?.onlineBookingEnabled) throw notFound('Salon');
    const settings = await this.settings(location.id);
    if (!settings.enabled) {
      return { enabled: false, count: 0, average: null, staff: [], items: [], nextBefore: null };
    }
    const base: Prisma.VisitReviewWhereInput = { locationId: location.id };
    const where = query.staffId ? { ...base, staffId: query.staffId } : base;
    const [summary, perStaff, staff, rows] = await Promise.all([
      this.prisma.visitReview.aggregate({ where, _count: true, _avg: { rating: true } }),
      this.prisma.visitReview.groupBy({
        by: ['staffId'],
        where: base,
        _count: true,
        _avg: { rating: true },
      }),
      this.prisma.staffMember.findMany({
        where: { locationId: location.id, active: true },
        select: { id: true, displayName: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.visitReview.findMany({
        where: { ...where, ...(query.before ? { id: { lt: query.before } } : {}) },
        include: {
          staff: { select: { displayName: true } },
          appointment: { select: { service: { select: { name: true } } } },
        },
        orderBy: { id: 'desc' },
        take: PAGE + 1,
      }),
    ]);
    const byStaff = new Map(perStaff.map((s) => [s.staffId, s]));
    const page = rows.slice(0, PAGE);
    return {
      enabled: true,
      count: summary._count,
      average: average(summary._avg.rating),
      staff: staff
        .filter((s) => byStaff.has(s.id))
        .map((s) => {
          const stats = byStaff.get(s.id)!;
          return {
            staffId: s.id,
            displayName: s.displayName,
            count: stats._count,
            average: average(stats._avg.rating),
          };
        }),
      items: page.map((r) => ({
        id: r.id,
        rating: r.rating,
        text: r.text,
        staffId: r.staffId,
        staffName: r.staff.displayName,
        serviceName: r.appointment.service.name,
        createdAt: r.createdAt.toISOString(),
      })),
      nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null,
    };
  }

  // ── The client: by "manage" link or in the client app ──

  async getByToken(token: string, now = new Date()): Promise<VisitReviewResponse> {
    return this.view(await this.visitByToken(token), now);
  }

  async writeByToken(
    token: string,
    input: WriteReviewInput,
    now = new Date(),
  ): Promise<VisitReviewResponse> {
    return this.write(await this.visitByToken(token), input, now);
  }

  /** A visit of the signed-in client (by their confirmed email); someone else's = 404. */
  async getForClient(email: string, id: string, now = new Date()): Promise<VisitReviewResponse> {
    return this.view(await this.clientVisit(email, id), now);
  }

  async writeForClient(
    email: string,
    id: string,
    input: WriteReviewInput,
    now = new Date(),
  ): Promise<VisitReviewResponse> {
    return this.write(await this.clientVisit(email, id), input, now);
  }

  // ── Helpers ──────────────────────────────────────────

  private async settings(locationId: string) {
    return (
      (await this.prisma.reviewSettings.findUnique({ where: { locationId } })) ??
      DEFAULT_REVIEW_SETTINGS
    );
  }

  private async visitByToken(token: string): Promise<ReviewableVisit> {
    const access = await this.prisma.appointmentAccessToken.findUnique({
      where: { tokenHash: hashToken(String(token ?? '')) },
      include: { appointment: true },
    });
    if (!access || access.expiresAt.getTime() <= Date.now()) throw notFound('Appointment');
    return access.appointment;
  }

  private async clientVisit(email: string, id: string): Promise<ReviewableVisit> {
    const visit = await this.prisma.appointment.findFirst({
      where: {
        id,
        customer: { email },
        status: { in: ['confirmed', 'cancelled', 'completed', 'no_show'] },
      },
    });
    if (!visit) throw notFound('Appointment');
    return visit;
  }

  /** Until when the visit can be reviewed; null when it cannot (now or ever). */
  private async reviewUntil(visit: ReviewableVisit, now: Date): Promise<Date | null> {
    if (!visit.customerId) return null;
    const tookPlace =
      visit.status === 'completed' ||
      (visit.status === 'confirmed' && visit.endAt.getTime() <= now.getTime());
    if (!tookPlace) return null;
    const until = new Date(visit.endAt.getTime() + REVIEW_DAYS * DAY_MS);
    if (until.getTime() <= now.getTime()) return null;
    const settings = await this.settings(visit.locationId);
    return settings.enabled ? until : null;
  }

  private async view(visit: ReviewableVisit, now: Date): Promise<VisitReviewResponse> {
    const [until, review] = await Promise.all([
      this.reviewUntil(visit, now),
      this.prisma.visitReview.findUnique({ where: { appointmentId: visit.id } }),
    ]);
    return toVisitReview(until, review);
  }

  private async write(
    visit: ReviewableVisit,
    input: WriteReviewInput,
    now: Date,
  ): Promise<VisitReviewResponse> {
    const until = await this.reviewUntil(visit, now);
    if (!until) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'REVIEW_NOT_POSSIBLE',
        'This visit cannot be reviewed (the salon does not collect reviews, the visit has not taken place or it was more than 30 days ago)',
      );
    }
    const data = { rating: input.rating, text: input.text ?? null };
    const review = await this.prisma.visitReview.upsert({
      where: { appointmentId: visit.id },
      create: {
        appointmentId: visit.id,
        locationId: visit.locationId,
        staffId: visit.staffId,
        ...data,
      },
      update: data,
    });
    return toVisitReview(until, review);
  }
}

function toSettings(row: ReviewSettings | null): ReviewSettingsResponse {
  const s = row ?? DEFAULT_REVIEW_SETTINGS;
  return { enabled: s.enabled, requestHours: s.requestHours, version: row?.version ?? 0 };
}

function toVisitReview(until: Date | null, review: VisitReview | null): VisitReviewResponse {
  return {
    canReview: until !== null,
    reviewUntil: until?.toISOString() ?? null,
    review: review
      ? {
          rating: review.rating,
          text: review.text,
          createdAt: review.createdAt.toISOString(),
          updatedAt: review.updatedAt.toISOString(),
        }
      : null,
  };
}

function average(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

const conflict = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    'The settings were changed by someone else. Reload and try again',
  );
