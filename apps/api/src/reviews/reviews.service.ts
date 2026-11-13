import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import { hashToken } from '../common/crypto';
import type { MembershipContext } from '../common/request-context';
import type { Appointment, Prisma, ReviewSettings, VisitReview } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { csvCell } from '../booking/customers-export';
import { instantToLocal } from '../scheduling/time';
import type {
  PublicReviewsResponse,
  ReviewSettingsResponse,
  SalonReviewResponse,
  SalonReviewsResponse,
  VisitReviewResponse,
} from './reviews.responses';
import type {
  ExportReviewsQuery,
  ListReviewsQuery,
  SalonReviewsQuery,
  ReplyReviewInput,
  UpdateReviewSettingsInput,
  WriteReviewInput,
} from './reviews.schemas';

const DAY_MS = 86_400_000;
/** A visit can be reviewed (and the review changed) until this many days after it ends. */
export const REVIEW_DAYS = 30;
const PAGE = 20;

const salonReviewInclude = {
  staff: { select: { displayName: true } },
  appointment: {
    select: {
      startAt: true,
      service: { select: { name: true } },
      customer: { select: { id: true, name: true, anonymizedAt: true } },
    },
  },
} satisfies Prisma.VisitReviewInclude;
type SalonReviewRow = Prisma.VisitReviewGetPayload<{ include: typeof salonReviewInclude }>;

/** Task 385: the columns of the reviews CSV in the four cabinet languages. */
const REVIEW_CSV_COLUMNS = {
  pl: [
    'Data opinii',
    'Ocena',
    'Specjalista',
    'Usługa',
    'Data wizyty',
    'Klient',
    'Opinia',
    'Odpowiedź salonu',
    'Data odpowiedzi',
  ],
  uk: [
    'Дата відгуку',
    'Оцінка',
    'Спеціаліст',
    'Послуга',
    'Дата візиту',
    'Клієнт',
    'Відгук',
    'Відповідь салону',
    'Дата відповіді',
  ],
  ru: [
    'Дата отзыва',
    'Оценка',
    'Специалист',
    'Услуга',
    'Дата визита',
    'Клиент',
    'Отзыв',
    'Ответ салона',
    'Дата ответа',
  ],
  en: [
    'Review date',
    'Stars',
    'Specialist',
    'Service',
    'Visit date',
    'Client',
    'Review',
    "Salon's answer",
    'Answer date',
  ],
} as const;

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
    query: SalonReviewsQuery,
  ): Promise<SalonReviewsResponse> {
    await this.access.readable(m, locationId);
    const settings = await this.settings(locationId);
    const visible: Prisma.VisitReviewWhereInput = {
      locationId,
      ...(m.role === 'staff' && !m.permissions.viewAllAppointments ? { staff: { userId } } : {}),
    };
    const ofStaff: Prisma.VisitReviewWhereInput = query.staffId
      ? { ...visible, staffId: query.staffId }
      : visible;
    const where: Prisma.VisitReviewWhereInput = query.serviceId
      ? { ...ofStaff, appointment: { serviceId: query.serviceId } }
      : ofStaff;
    const [summary, byStars, unanswered, perStaff, staff, services, rows] = await Promise.all([
      this.prisma.visitReview.aggregate({ where, _count: true, _avg: { rating: true } }),
      this.starCounts(where),
      this.prisma.visitReview.count({ where: { ...where, reply: null } }),
      // Task 383: the chips "Kasia ★ 4,8 (12)" — every specialist with reviews the user may see.
      this.prisma.visitReview.groupBy({
        by: ['staffId'],
        where: visible,
        _count: true,
        _avg: { rating: true },
      }),
      this.prisma.staffMember.findMany({
        where: { locationId },
        select: { id: true, displayName: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.serviceRatings(locationId, ofStaff),
      this.prisma.visitReview.findMany({
        where: {
          ...where,
          ...(query.rating ? { rating: query.rating } : {}),
          ...(query.unanswered ? { reply: null } : {}),
          ...(query.before ? { id: { lt: query.before } } : {}),
        },
        include: salonReviewInclude,
        orderBy: { id: 'desc' },
        take: PAGE + 1,
      }),
    ]);
    const page = rows.slice(0, PAGE);
    return {
      enabled: settings.enabled,
      count: summary._count,
      average: average(summary._avg.rating),
      stars: byStars,
      unanswered,
      staff: staff
        .filter((s) => perStaff.some((p) => p.staffId === s.id))
        .map((s) => {
          const stats = perStaff.find((p) => p.staffId === s.id)!;
          return {
            staffId: s.id,
            displayName: s.displayName,
            count: stats._count,
            average: average(stats._avg.rating),
          };
        }),
      services,
      items: page.map(toSalonReview),
      nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * Task 420: the chips "Strzyżenie ★ 4,6 (9)" — every service (removed ones too) with reviews
   * among `where` (the reviews the user may see, of the chosen specialist), salon order.
   */
  private async serviceRatings(
    locationId: string,
    where: Prisma.VisitReviewWhereInput,
  ): Promise<SalonReviewsResponse['services']> {
    const [rows, services] = await Promise.all([
      this.prisma.visitReview.findMany({
        where,
        select: { rating: true, appointment: { select: { serviceId: true } } },
      }),
      this.prisma.service.findMany({
        where: { locationId },
        select: { id: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    const stats = new Map<string, { count: number; sum: number }>();
    for (const r of rows) {
      const s = stats.get(r.appointment.serviceId) ?? { count: 0, sum: 0 };
      s.count += 1;
      s.sum += r.rating;
      stats.set(r.appointment.serviceId, s);
    }
    return services
      .filter((s) => stats.has(s.id))
      .map((s) => {
        const { count, sum } = stats.get(s.id)!;
        return { serviceId: s.id, name: s.name, count, average: average(sum / count) };
      });
  }

  /**
   * Task 385: every review of the location (with the list's filters) as a CSV file for the
   * owner and managers: the day, stars, specialist, service, client's name, words and the
   * salon's answer. Newest first; each export is written to the audit log.
   */
  async exportCsv(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ExportReviewsQuery,
  ): Promise<string> {
    const location = await this.access.readable(m, locationId);
    const rows = await this.prisma.visitReview.findMany({
      where: {
        locationId,
        ...(query.staffId ? { staffId: query.staffId } : {}),
        ...(query.serviceId ? { appointment: { serviceId: query.serviceId } } : {}),
        ...(query.rating ? { rating: query.rating } : {}),
        ...(query.unanswered ? { reply: null } : {}),
      },
      include: salonReviewInclude,
      orderBy: { id: 'desc' },
      take: 10_000,
    });
    const day = (d: Date | null) => (d ? instantToLocal(d.getTime(), location.timezone).date : '');
    const lines = [REVIEW_CSV_COLUMNS[query.lang].map(csvCell).join(';')];
    for (const r of rows) {
      const customer = r.appointment.customer;
      lines.push(
        [
          day(r.createdAt),
          String(r.rating),
          r.staff.displayName,
          r.appointment.service.name,
          day(r.appointment.startAt),
          customer && !customer.anonymizedAt ? customer.name : '',
          r.text ?? '',
          r.reply ?? '',
          day(r.repliedAt),
        ]
          .map(csvCell)
          .join(';'),
      );
    }
    await this.audit.record({
      organizationId: m.organizationId,
      actorUserId: userId,
      action: 'reviews.exported',
      entityType: 'location',
      entityId: locationId,
      metadata: { count: rows.length },
    });
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  /**
   * Task 211: the salon answers a review publicly (owners and managers of the location). The
   * answer is shown under the review on the salon page and to the client; writing it again
   * changes it. The review's own "changed" time stays the client's.
   */
  async reply(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    reviewId: string,
    input: ReplyReviewInput,
  ): Promise<SalonReviewResponse> {
    return this.setReply(m, actorUserId, locationId, reviewId, input.text);
  }

  async removeReply(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    reviewId: string,
  ): Promise<SalonReviewResponse> {
    return this.setReply(m, actorUserId, locationId, reviewId, null);
  }

  private async setReply(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    reviewId: string,
    text: string | null,
  ): Promise<SalonReviewResponse> {
    await this.access.writable(m, locationId);
    const saved = await this.prisma.$transaction(async (tx) => {
      const current = await tx.visitReview.findFirst({ where: { id: reviewId, locationId } });
      if (!current) throw notFound('Review');
      const row = await tx.visitReview.update({
        where: { id: reviewId },
        data: {
          reply: text,
          repliedAt: text === null ? null : new Date(),
          // The review's "changed" time is the client's, not the salon's answer.
          updatedAt: current.updatedAt,
        },
        include: salonReviewInclude,
      });
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: text === null ? 'review.reply_removed' : 'review.reply_set',
          entityType: 'review',
          entityId: reviewId,
          metadata: { locationId, appointmentId: current.appointmentId },
        },
        tx,
      );
      return row;
    });
    return toSalonReview(saved);
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
      return {
        enabled: false,
        count: 0,
        average: null,
        stars: [0, 0, 0, 0, 0],
        staff: [],
        items: [],
        nextBefore: null,
      };
    }
    const base: Prisma.VisitReviewWhereInput = { locationId: location.id };
    const where = query.staffId ? { ...base, staffId: query.staffId } : base;
    const [summary, byStars, perStaff, staff, rows] = await Promise.all([
      this.prisma.visitReview.aggregate({ where, _count: true, _avg: { rating: true } }),
      this.starCounts(where),
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
        where: {
          ...where,
          ...(query.rating ? { rating: query.rating } : {}),
          ...(query.before ? { id: { lt: query.before } } : {}),
        },
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
      stars: byStars,
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
        reply: r.reply,
        repliedAt: r.repliedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null,
    };
  }

  /** Task 380: how many of the reviews have 1…5 stars (index 0 = one star). */
  private async starCounts(where: Prisma.VisitReviewWhereInput): Promise<number[]> {
    const rows = await this.prisma.visitReview.groupBy({
      by: ['rating'],
      where,
      _count: { _all: true },
    });
    const counts = [0, 0, 0, 0, 0];
    for (const row of rows) {
      if (row.rating >= 1 && row.rating <= 5) counts[row.rating - 1] = row._count._all;
    }
    return counts;
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
          reply: review.reply,
          repliedAt: review.repliedAt?.toISOString() ?? null,
          createdAt: review.createdAt.toISOString(),
          updatedAt: review.updatedAt.toISOString(),
        }
      : null,
  };
}

function toSalonReview(r: SalonReviewRow): SalonReviewResponse {
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
    reply: r.reply,
    repliedAt: r.repliedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
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
