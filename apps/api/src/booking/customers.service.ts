import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, forbidden, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { Customer, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';
import type {
  CreateCustomerInput,
  ListCustomersQuery,
  UpdateCustomerInput,
} from './booking.schemas';
import type {
  CustomerDetailResponse,
  CustomerResponse,
  CustomerSegmentsResponse,
  CustomerTagsResponse,
} from './booking.responses';

export type { CustomerDetailResponse, CustomerResponse } from './booking.responses';

/** The filters of the client list, without which rows to return. */
export type ClientFilters = Omit<ListCustomersQuery, 'limit' | 'offset'>;

/** Task 277: which rows of the list — `limit` of them after the first `offset`. */
interface Page {
  offset: number;
  limit: number;
}

const slicePage = <T>(rows: T[], page: Page | null): T[] =>
  page ? rows.slice(page.offset, page.offset + page.limit) : rows;

const clientExists = (code: string, message: string, existingId: string): AppException =>
  new AppException(HttpStatus.CONFLICT, code, message, [
    { path: 'customerId', message: existingId },
  ]);

/** Task 21: the client's data were erased; the card cannot be filled in again. */
export const customerAnonymized = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'CUSTOMER_ANONYMIZED',
    "The client's personal data were erased (GDPR)",
  );

/**
 * Clients belong to the organization. Owners see all of them; managers see
 * clients who have (had) appointments in their locations. Staff members see the
 * card of a client they have (had) an appointment with — or anyone in their
 * location with viewAllAppointments — and only the parts their permissions allow.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(m: MembershipContext, query: ListCustomersQuery): Promise<CustomerResponse[]> {
    const rows = await this.matching(m, query, { offset: query.offset, limit: query.limit });
    return rows.map((c) => toCustomer(c, m));
  }

  /**
   * Task 275: the ids of every client the list would show with these filters (no limit), in the
   * list's order — for the CSV of the filtered list.
   */
  async matchingIds(m: MembershipContext, query: ClientFilters): Promise<string[]> {
    const rows = await this.matching(m, query, null);
    return rows.map((c) => c.id);
  }

  /**
   * The clients the list shows, in the list's order: one page of them (task 277: `offset` for
   * "Pokaż więcej"), or all of them with `page` null.
   */
  private async matching(
    m: MembershipContext,
    query: ClientFilters,
    page: Page | null,
  ): Promise<Customer[]> {
    if (query.marketing && !m.permissions.viewClientContacts) return [];
    if (query.birthdayDays) return this.birthdays(m, query, page);
    // Task 248: the newest clients first, by their first visit.
    const newcomers = query.newDays ? await this.newcomers(m, query.newDays) : null;
    // Task 262: clients past their usual time to come back, the most recently due first.
    const overdue = query.overdue ? await this.overdue(m) : null;
    // Task 264: clients who did not come in the last year, the most recent no-show first.
    const noShows = query.noShows ? await this.noShows(m) : null;
    // Task 270: clients who came once and did not come back, the most recent first.
    const once = query.once ? await this.once(m) : null;
    const search = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { phone: { contains: query.search.replace(/\s/g, '') } },
            { email: { contains: query.search.toLowerCase() } },
            { tags: { has: query.search } },
          ],
        }
      : {};
    const ordered = Boolean(newcomers || overdue || noShows || once);
    // Task 279: by the latest visit or by the number of visits (in the caller's salons).
    // Task 283: who paid the most — only for those who see the money (the list is for owners and
    // managers anyway; a specialist would get A–Z).
    const sort = query.sort === 'paid' && m.role === 'staff' ? 'name' : query.sort;
    const visits =
      ordered || sort === 'name'
        ? null
        : sort === 'next'
          ? await this.nextVisits(m)
          : sort === 'paid'
            ? await this.paidTotals(m)
            : await this.visitStats(m);
    const rows = await this.prisma.customer.findMany({
      // Erased clients (task 21) are not listed; their visits still show in the calendar.
      where: {
        AND: [
          await this.visibleTo(m, null),
          search,
          { anonymizedAt: null },
          query.inactiveDays ? this.inactiveSince(m, query.inactiveDays) : {},
          query.tag ? { tags: { has: query.tag } } : {},
          query.marketing ? { id: { in: await this.consented(m.organizationId) } } : {},
          newcomers ? { id: { in: [...newcomers.keys()] } } : {},
          overdue ? { id: { in: [...overdue.keys()] } } : {},
          noShows ? { id: { in: [...noShows.keys()] } } : {},
          once ? { id: { in: [...once.keys()] } } : {},
        ],
      },
      // The id keeps clients with the same name in one order from page to page (task 277).
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...(ordered || visits || !page ? {} : { skip: page.offset, take: page.limit }),
    });
    if (visits) {
      const key = (id: string): number => {
        const v = visits.get(id);
        if (!v) return Number.MIN_SAFE_INTEGER;
        // Task 281: the nearest booked visit first — the earlier, the higher.
        if (sort === 'next') return -v.latest.getTime();
        return sort === 'recent' ? v.latest.getTime() : v.count;
      };
      // Stable: equal keys stay in name order (and clients without visits come last).
      rows.sort((a, b) => key(b.id) - key(a.id));
      return slicePage(rows, page);
    }
    if (newcomers) {
      rows.sort((a, b) => newcomers.get(b.id)!.getTime() - newcomers.get(a.id)!.getTime());
    }
    if (overdue) {
      rows.sort((a, b) => overdue.get(b.id)!.getTime() - overdue.get(a.id)!.getTime());
    }
    if (noShows) {
      rows.sort((a, b) => noShows.get(b.id)!.getTime() - noShows.get(a.id)!.getTime());
    }
    if (once) {
      rows.sort((a, b) => once.get(b.id)!.getTime() - once.get(a.id)!.getTime());
    }
    return ordered ? slicePage(rows, page) : rows;
  }

  /**
   * Task 281: per client, the start of the nearest visit booked from now on in the salons the
   * caller works in (in `latest`, so the list sorts it like the other orders).
   */
  private async nextVisits(
    m: MembershipContext,
  ): Promise<Map<string, { count: number; latest: Date }>> {
    const groups = await this.prisma.appointment.groupBy({
      by: ['customerId'],
      where: {
        status: 'confirmed',
        startAt: { gte: new Date() },
        customerId: { not: null },
        location: { organizationId: m.organizationId },
        ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
      },
      _count: { _all: true },
      _min: { startAt: true },
    });
    return new Map(
      groups
        .filter((g) => g.customerId && g._min.startAt)
        .map((g) => [g.customerId!, { count: g._count._all, latest: g._min.startAt! }]),
    );
  }

  /**
   * Task 283: per client, what the paid visits brought in the salons the caller works in — the
   * same rule as "Zapłacono" in the client card (price minus discount, cancelled visits left
   * out), in `count` so the list sorts it like "Najwięcej wizyt". With salons in several
   * currencies only the main one counts (the currency most of the caller's salons use, the
   * oldest salon's on a tie): sums in different currencies cannot be compared.
   */
  private async paidTotals(
    m: MembershipContext,
  ): Promise<Map<string, { count: number; latest: Date }>> {
    const salons = await this.prisma.location.findMany({
      where: {
        organizationId: m.organizationId,
        ...(m.role === 'owner' ? {} : { id: { in: m.locationIds } }),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, currency: true },
    });
    const uses = new Map<string, number>();
    for (const l of salons) uses.set(l.currency, (uses.get(l.currency) ?? 0) + 1);
    const main = [...uses].reduce<[string, number] | null>(
      (best, entry) => (!best || entry[1] > best[1] ? entry : best),
      null,
    )?.[0];
    const groups = await this.prisma.appointment.groupBy({
      by: ['customerId'],
      where: {
        paidAt: { not: null },
        status: { not: 'cancelled' },
        customerId: { not: null },
        locationId: { in: salons.filter((l) => l.currency === main).map((l) => l.id) },
      },
      _sum: { priceGrosze: true, discountGrosze: true },
      _max: { startAt: true },
    });
    return new Map(
      groups
        .filter((g) => g.customerId && g._max.startAt)
        .map((g) => [
          g.customerId!,
          {
            count: (g._sum.priceGrosze ?? 0) - (g._sum.discountGrosze ?? 0),
            latest: g._max.startAt!,
          },
        ]),
    );
  }

  /**
   * Task 279: per client, how many visits took place in the salons the caller works in, and the
   * start of the latest one.
   */
  private async visitStats(
    m: MembershipContext,
  ): Promise<Map<string, { count: number; latest: Date }>> {
    const groups = await this.prisma.appointment.groupBy({
      by: ['customerId'],
      where: {
        status: 'completed',
        customerId: { not: null },
        location: { organizationId: m.organizationId },
        ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
      },
      _count: { _all: true },
      _max: { startAt: true },
    });
    return new Map(
      groups
        .filter((g) => g.customerId && g._max.startAt)
        .map((g) => [g.customerId!, { count: g._count._all, latest: g._max.startAt! }]),
    );
  }

  /**
   * Task 248: clients whose first visit that took place — in the salons the caller works in —
   * was in the last `days` days, with that first visit's start.
   */
  private async newcomers(m: MembershipContext, days: number): Promise<Map<string, Date>> {
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const firsts = await this.prisma.appointment.groupBy({
      by: ['customerId'],
      where: {
        status: 'completed',
        customerId: { not: null },
        location: { organizationId: m.organizationId },
        ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
      },
      _min: { startAt: true },
      having: { startAt: { _min: { gte: since } } },
    });
    return new Map(
      firsts
        .filter((f) => f.customerId && f._min.startAt)
        .map((f) => [f.customerId!, f._min.startAt!]),
    );
  }

  /**
   * Task 262: clients with a habit — at least three visits that took place on different days in
   * the salons the caller works in (`rhythm`, task 250) — whose latest visit plus their usual
   * break is already behind, and who have nothing booked ahead there; with that due date.
   */
  private overdue(m: MembershipContext): Promise<Map<string, Date>> {
    return dueToComeBack(this.prisma, {
      location: { organizationId: m.organizationId },
      ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
    });
  }

  /**
   * Task 264: clients with a visit marked "did not come" in the last 365 days — in the salons the
   * caller works in — with the latest such visit's start.
   */
  private noShows(m: MembershipContext): Promise<Map<string, Date>> {
    return missedVisits(this.prisma, {
      location: { organizationId: m.organizationId },
      ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
    });
  }

  /**
   * Task 270: clients who came once in the salons the caller works in (`cameOnce`), with that
   * visit's start.
   */
  private once(m: MembershipContext): Promise<Map<string, Date>> {
    return cameOnce(this.prisma, {
      location: { organizationId: m.organizationId },
      ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
    });
  }

  /**
   * Task 245: the organization's clients whose latest answer about the salon messages is "yes"
   * (a later "no" — the unsubscribe link — takes them out).
   */
  private async consented(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ customer_id: string; granted: boolean }[]>`
      SELECT DISTINCT ON (r.customer_id) r.customer_id, r.granted
      FROM consent_record r
      JOIN customer c ON c.id = r.customer_id
      WHERE c.organization_id = ${organizationId}::uuid AND r.type = 'marketing'
      ORDER BY r.customer_id, r.created_at DESC, r.id DESC`;
    return rows.filter((r) => r.granted).map((r) => r.customer_id);
  }

  /**
   * Task 240: clients whose birthday falls in the next `birthdayDays` days (today included,
   * the salon's day), soonest first. A birthday is a contact detail: without the permission to
   * see client contacts the list is empty. 29 February is congratulated on 28 February in a
   * year without it.
   */
  private async birthdays(
    m: MembershipContext,
    query: ClientFilters,
    page: Page | null,
  ): Promise<Customer[]> {
    if (!m.permissions.viewClientContacts) return [];
    const days = birthdayWindow(await this.today(m), query.birthdayDays ?? 1);
    const rows = await this.prisma.customer.findMany({
      where: {
        AND: [
          await this.visibleTo(m, null),
          { anonymizedAt: null, birthday: { in: [...days.keys()] } },
          query.search
            ? {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' as const } },
                  { phone: { contains: query.search.replace(/\s/g, '') } },
                  { email: { contains: query.search.toLowerCase() } },
                ],
              }
            : {},
          query.tag ? { tags: { has: query.tag } } : {},
          query.marketing ? { id: { in: await this.consented(m.organizationId) } } : {},
        ],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return slicePage(
      rows.sort((a, b) => days.get(a.birthday!)! - days.get(b.birthday!)!),
      page,
    );
  }

  /** Task 240: today in the caller's first salon (the order of the salons in the cabinet). */
  private async today(m: MembershipContext): Promise<string> {
    const location = await this.prisma.location.findFirst({
      where: {
        organizationId: m.organizationId,
        ...(m.role === 'owner' ? {} : { id: { in: m.locationIds } }),
      },
      orderBy: { createdAt: 'asc' },
      select: { timezone: true },
    });
    return instantToLocal(Date.now(), location?.timezone ?? 'Europe/Warsaw').date;
  }

  /**
   * Task 273: how many clients each quick filter above the client list would show — the same
   * rules and visibility as the filters themselves (`list`), without the search and label.
   * Birthdays and consents are contact details: null without the permission to see them.
   */
  async segments(m: MembershipContext): Promise<CustomerSegmentsResponse> {
    const visible = await this.visibleTo(m, null);
    const count = (where: Prisma.CustomerWhereInput) =>
      this.prisma.customer.count({ where: { AND: [visible, { anonymizedAt: null }, where] } });
    const among = (ids: Iterable<string>) => count({ id: { in: [...ids] } });
    const contacts = m.permissions.viewClientContacts;
    const [birthdays, consented, newcomers, overdue, noShows, once] = await Promise.all([
      contacts
        ? this.today(m).then((today) =>
            count({ birthday: { in: [...birthdayWindow(today, 7).keys()] } }),
          )
        : null,
      contacts ? this.consented(m.organizationId).then(among) : null,
      this.newcomers(m, 30).then((ids) => among(ids.keys())),
      this.overdue(m).then((ids) => among(ids.keys())),
      this.noShows(m).then((ids) => among(ids.keys())),
      this.once(m).then((ids) => among(ids.keys())),
    ]);
    return { birthdays, consented, newcomers, overdue, noShows, once };
  }

  /**
   * Task 224: every label of the clients the caller can see, with how many clients have it —
   * for the label chips above the client list. Labels are notes: without the permission to see
   * notes the list is empty.
   */
  async tags(m: MembershipContext): Promise<CustomerTagsResponse> {
    if (!m.permissions.viewClientNotes) return { tags: [] };
    const rows = await this.prisma.customer.findMany({
      where: {
        AND: [await this.visibleTo(m, null), { anonymizedAt: null }, { tags: { isEmpty: false } }],
      },
      select: { tags: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tags = [...counts]
      .map(([tag, clients]) => ({ tag, clients }))
      .sort((a, b) => b.clients - a.clients || a.tag.localeCompare(b.tag, 'pl'))
      .slice(0, 50);
    return { tags };
  }

  async get(
    m: MembershipContext,
    userId: string,
    customerId: string,
  ): Promise<CustomerDetailResponse> {
    const customer = await this.findVisible(m, userId, customerId);
    const ownOnly = m.role === 'staff' && !m.permissions.viewClientHistory;
    const ownStaff = ownOnly ? await this.ownStaffIds(m, userId) : null;
    const where: Prisma.AppointmentWhereInput = {
      customerId,
      status: { notIn: ['held', 'expired'] },
      ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
      ...(ownStaff ? { staffId: { in: ownStaff } } : {}),
    };
    const [consent, visits, summary] = await Promise.all([
      this.prisma.consentRecord.findFirst({
        where: { customerId, type: 'marketing' },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.appointment.findMany({
        where,
        include: { service: true, staff: true },
        orderBy: { startAt: 'desc' },
        take: 100,
      }),
      this.summary(where, m.role !== 'staff'),
    ]);
    return {
      ...toCustomer(customer, m),
      marketingConsent: m.role === 'staff' ? null : (consent?.granted ?? false),
      visits: visits.map((a) => ({
        id: a.id,
        locationId: a.locationId,
        start: a.startAt.toISOString(),
        status: a.status,
        serviceName: a.service.name,
        staffName: a.staff.displayName,
      })),
      summary,
    };
  }

  /**
   * Task 98: how the client comes — visits that took place, no-shows, cancellations, the first
   * and latest visit and (for owners and managers) what the paid visits brought, per currency.
   */
  private async summary(
    where: Prisma.AppointmentWhereInput,
    withMoney: boolean,
  ): Promise<CustomerDetailResponse['summary']> {
    const [byStatus, upcoming, dates, paid, starts] = await Promise.all([
      this.prisma.appointment.groupBy({
        by: ['status', 'cancelledBy'],
        where,
        _count: { _all: true },
      }),
      this.prisma.appointment.count({
        where: { AND: [where, { status: 'confirmed', startAt: { gte: new Date() } }] },
      }),
      this.prisma.appointment.aggregate({
        where: { AND: [where, { status: 'completed' }] },
        _min: { startAt: true },
        _max: { startAt: true },
      }),
      withMoney
        ? this.prisma.appointment.groupBy({
            by: ['locationId'],
            where: { AND: [where, { paidAt: { not: null }, status: { not: 'cancelled' } }] },
            _sum: { priceGrosze: true, discountGrosze: true },
          })
        : null,
      this.prisma.appointment.findMany({
        where: { AND: [where, { status: 'completed' }] },
        orderBy: { startAt: 'asc' },
        select: {
          startAt: true,
          service: { select: { name: true } },
          staff: { select: { displayName: true } },
        },
        take: 500,
      }),
    ]);
    const count = (match: (row: (typeof byStatus)[number]) => boolean): number =>
      byStatus.filter(match).reduce((sum, row) => sum + row._count._all, 0);
    let money: CustomerDetailResponse['summary']['paid'] = null;
    if (paid) {
      const locations = await this.prisma.location.findMany({
        where: { id: { in: paid.map((p) => p.locationId) } },
        select: { id: true, currency: true },
      });
      const currencyOf = new Map(locations.map((l) => [l.id, l.currency]));
      const totals = new Map<string, number>();
      for (const row of paid) {
        const currency = currencyOf.get(row.locationId) ?? 'PLN';
        const amount = (row._sum.priceGrosze ?? 0) - (row._sum.discountGrosze ?? 0);
        totals.set(currency, (totals.get(currency) ?? 0) + amount);
      }
      money = [...totals]
        .map(([currency, amountGrosze]) => ({ currency, amountGrosze }))
        .sort((a, b) => b.amountGrosze - a.amountGrosze);
    }
    return {
      completed: count((r) => r.status === 'completed'),
      noShow: count((r) => r.status === 'no_show'),
      cancelledByClient: count((r) => r.status === 'cancelled' && r.cancelledBy === 'customer'),
      cancelledBySalon: count((r) => r.status === 'cancelled' && r.cancelledBy !== 'customer'),
      upcoming,
      firstVisitAt: dates._min.startAt?.toISOString() ?? null,
      lastVisitAt: dates._max.startAt?.toISOString() ?? null,
      rhythmDays: rhythm(starts.map((a) => a.startAt)),
      favoriteService: favorite(starts.map((a) => a.service.name)),
      favoriteStaff: favorite(starts.map((a) => a.staff.displayName)),
      paid: money,
    };
  }

  /**
   * Task 140: clients who came before (a visit took place) but not in the last `days` days and
   * have nothing booked ahead — in the salons the user works in (owners: the whole network).
   */
  private inactiveSince(m: MembershipContext, days: number): Prisma.CustomerWhereInput {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
    const here = m.role === 'owner' ? {} : { locationId: { in: m.locationIds } };
    return {
      AND: [
        { appointments: { some: { ...here, status: 'completed' } } },
        {
          appointments: {
            none: {
              ...here,
              OR: [
                { status: 'completed', startAt: { gte: since } },
                { status: 'confirmed', startAt: { gte: since } },
              ],
            },
          },
        },
      ],
    };
  }

  /** Owners and managers; protects against duplicates by email and (unless allowed) by phone. */
  async create(
    m: MembershipContext,
    actorUserId: string,
    input: CreateCustomerInput,
  ): Promise<CustomerDetailResponse> {
    const { allowDuplicatePhone, ...data } = input;
    if (data.email) {
      const sameEmail = await this.prisma.customer.findFirst({
        where: { organizationId: m.organizationId, email: data.email },
      });
      if (sameEmail) {
        throw clientExists(
          'CUSTOMER_EMAIL_EXISTS',
          'A client with this email exists',
          sameEmail.id,
        );
      }
    }
    if (!allowDuplicatePhone) {
      const samePhone = await this.prisma.customer.findFirst({
        where: { organizationId: m.organizationId, phone: data.phone },
      });
      if (samePhone) {
        throw clientExists(
          'CUSTOMER_PHONE_EXISTS',
          'A client with this phone number exists; send allowDuplicatePhone=true to add anyway',
          samePhone.id,
        );
      }
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: { ...data, organizationId: m.organizationId },
      });
      await this.record(tx, m, actorUserId, 'customer.created', customer.id);
      return customer;
    });
    return {
      ...toCustomer(created, m),
      marketingConsent: false,
      visits: [],
      summary: {
        completed: 0,
        noShow: 0,
        cancelledByClient: 0,
        cancelledBySalon: 0,
        upcoming: 0,
        firstVisitAt: null,
        lastVisitAt: null,
        rhythmDays: null,
        favoriteService: null,
        favoriteStaff: null,
        paid: m.role === 'staff' ? null : [],
      },
    };
  }

  async update(
    m: MembershipContext,
    actorUserId: string,
    customerId: string,
    input: UpdateCustomerInput,
  ): Promise<CustomerDetailResponse> {
    const existing = await this.findVisible(m, actorUserId, customerId);
    if (existing.anonymizedAt) throw customerAnonymized();
    const { version, ...fields } = input;
    if (m.role === 'staff') {
      const onlyNotes = Object.keys(fields).every((key) => key === 'note' || key === 'tags');
      if (!onlyNotes || !m.permissions.editClientNotes || !m.permissions.viewClientNotes) {
        throw forbidden();
      }
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const result = await tx.customer.updateMany({
          where: { id: customerId, organizationId: m.organizationId, version },
          data: { ...fields, version: { increment: 1 } },
        });
        if (result.count !== 1) {
          throw new AppException(
            HttpStatus.CONFLICT,
            'VERSION_CONFLICT',
            'The client was changed by someone else. Reload and try again',
          );
        }
        await this.record(tx, m, actorUserId, 'customer.updated', customerId, Object.keys(fields));
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const other = await this.prisma.customer.findFirst({
          where: { organizationId: m.organizationId, email: fields.email ?? undefined },
        });
        throw clientExists(
          'CUSTOMER_EMAIL_EXISTS',
          'A client with this email exists',
          other?.id ?? '',
        );
      }
      throw error;
    }
    return this.get(m, actorUserId, customerId);
  }

  // ── Helpers ───────────────────────────────────────────

  private async ownStaffIds(m: MembershipContext, userId: string): Promise<string[]> {
    const own = await this.prisma.staffMember.findMany({
      where: { userId, locationId: { in: m.locationIds } },
      select: { id: true },
    });
    return own.map((s) => s.id);
  }

  /** userId is needed for staff members (their own appointments decide what they see). */
  private async visibleTo(
    m: MembershipContext,
    userId: string | null,
  ): Promise<Prisma.CustomerWhereInput> {
    if (m.role === 'owner') return { organizationId: m.organizationId };
    if (m.role === 'manager' || m.permissions.viewAllAppointments) {
      return {
        organizationId: m.organizationId,
        appointments: { some: { locationId: { in: m.locationIds } } },
      };
    }
    const own = userId ? await this.ownStaffIds(m, userId) : [];
    return {
      organizationId: m.organizationId,
      appointments: { some: { staffId: { in: own } } },
    };
  }

  private async findVisible(
    m: MembershipContext,
    userId: string,
    customerId: string,
  ): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({
      where: { AND: [{ id: customerId }, await this.visibleTo(m, userId)] },
    });
    if (!customer) throw notFound('Customer');
    return customer;
  }

  private record(
    tx: Prisma.TransactionClient,
    m: MembershipContext,
    actorUserId: string,
    action: string,
    entityId: string,
    fields?: string[],
  ): Promise<void> {
    // Field names only: the values are personal data.
    return this.audit.record(
      {
        organizationId: m.organizationId,
        actorUserId,
        action,
        entityType: 'customer',
        entityId,
        ...(fields ? { metadata: { fields } } : {}),
      },
      tx,
    );
  }
}

function toCustomer(c: Customer, m: MembershipContext): CustomerResponse {
  const contacts = m.permissions.viewClientContacts;
  const notes = m.permissions.viewClientNotes;
  return {
    id: c.id,
    name: c.name,
    phone: contacts ? c.phone : null,
    email: contacts ? c.email : null,
    locale: c.locale,
    note: notes ? c.note : null,
    tags: notes ? c.tags : null,
    birthday: contacts ? c.birthday : null,
    anonymizedAt: c.anonymizedAt?.toISOString() ?? null,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Task 240: "MM-DD" of `days` days from `today` ("YYYY-MM-DD") → how many days away. In a year
 * without 29 February, "02-29" counts as 28 February.
 */
export function birthdayWindow(today: string, days: number): Map<string, number> {
  const window = new Map<string, number>();
  const start = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86_400_000);
    const mmdd = date.toISOString().slice(5, 10);
    window.set(mmdd, i);
    const year = date.getUTCFullYear();
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (mmdd === '02-28' && !leap) window.set('02-29', i);
  }
  return window;
}

/**
 * Tasks 262, 263: clients with a habit — at least three visits that took place on different days
 * among the visits `here` matches (`rhythm`, task 250) — whose latest visit plus their usual break
 * is already behind and who have nothing booked ahead there; with that due date.
 */
export async function dueToComeBack(
  prisma: PrismaService,
  here: Prisma.AppointmentWhereInput,
  now = Date.now(),
): Promise<Map<string, Date>> {
  const [visits, booked] = await Promise.all([
    prisma.appointment.findMany({
      where: { AND: [here, { status: 'completed', customerId: { not: null } }] },
      orderBy: [{ customerId: 'asc' }, { startAt: 'asc' }],
      select: { customerId: true, startAt: true },
    }),
    prisma.appointment.findMany({
      where: {
        AND: [
          here,
          { status: 'confirmed', startAt: { gte: new Date(now) }, customerId: { not: null } },
        ],
      },
      distinct: ['customerId'],
      select: { customerId: true },
    }),
  ]);
  const ahead = new Set(booked.map((b) => b.customerId));
  const starts = new Map<string, Date[]>();
  for (const v of visits) {
    if (!v.customerId || ahead.has(v.customerId)) continue;
    const list = starts.get(v.customerId) ?? [];
    list.push(v.startAt);
    starts.set(v.customerId, list);
  }
  const due = new Map<string, Date>();
  for (const [id, list] of starts) {
    const days = rhythm(list);
    if (days === null) continue;
    const at = new Date(list[list.length - 1]!.getTime() + days * 86_400_000);
    if (at.getTime() <= now) due.set(id, at);
  }
  return due;
}

/**
 * Tasks 264, 265: clients with a visit marked "did not come" in the last 365 days among the visits
 * `here` matches, with the latest such visit's start.
 */
export async function missedVisits(
  prisma: PrismaService,
  here: Prisma.AppointmentWhereInput,
  now = Date.now(),
): Promise<Map<string, Date>> {
  const latest = await prisma.appointment.groupBy({
    by: ['customerId'],
    where: {
      AND: [
        here,
        {
          status: 'no_show',
          customerId: { not: null },
          startAt: { gte: new Date(now - 365 * 86_400_000), lte: new Date(now) },
        },
      ],
    },
    _max: { startAt: true },
  });
  return new Map(
    latest
      .filter((l) => l.customerId && l._max.startAt)
      .map((l) => [l.customerId!, l._max.startAt!]),
  );
}

/**
 * Tasks 270, 271: clients who came once among the visits `here` matches — every visit that took
 * place falls on one day (two services in a row are one visit), 30 to 365 days ago — and who have
 * nothing booked ahead; with that visit's start. Fresher first visits are under "Nowi (30 dni)"
 * (task 248).
 */
export async function cameOnce(
  prisma: PrismaService,
  here: Prisma.AppointmentWhereInput,
  now = Date.now(),
): Promise<Map<string, Date>> {
  const [spans, booked] = await Promise.all([
    prisma.appointment.groupBy({
      by: ['customerId'],
      where: { AND: [here, { status: 'completed', customerId: { not: null } }] },
      _min: { startAt: true },
      _max: { startAt: true },
      having: {
        startAt: {
          _min: { gte: new Date(now - 365 * 86_400_000) },
          _max: { lte: new Date(now - 30 * 86_400_000) },
        },
      },
    }),
    prisma.appointment.findMany({
      where: {
        AND: [
          here,
          { status: 'confirmed', startAt: { gte: new Date(now) }, customerId: { not: null } },
        ],
      },
      distinct: ['customerId'],
      select: { customerId: true },
    }),
  ]);
  const ahead = new Set(booked.map((b) => b.customerId));
  const once = new Map<string, Date>();
  for (const span of spans) {
    const first = span._min.startAt;
    const last = span._max.startAt;
    if (!span.customerId || !first || !last || ahead.has(span.customerId)) continue;
    // Same rule as `rhythm`: visits less than half a day apart are one visit.
    if (Math.round((last.getTime() - first.getTime()) / 86_400_000) > 0) continue;
    once.set(span.customerId, last);
  }
  return once;
}

/**
 * Task 250: the typical (median) days between visits in a row that took place on different days;
 * null with fewer than two such gaps (three visits).
 */
export function rhythm(starts: Date[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const days = Math.round((starts[i]!.getTime() - starts[i - 1]!.getTime()) / 86_400_000);
    if (days > 0) gaps.push(days);
  }
  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return Math.round(gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2);
}

/**
 * Task 261: the name that comes up most often among the visits that took place (oldest first);
 * the latest wins a tie. Null below two visits with that name — one visit is not a habit.
 */
export function favorite(names: string[]): { name: string; visits: number } | null {
  const counts = new Map<string, { visits: number; last: number }>();
  names.forEach((name, i) => {
    const row = counts.get(name);
    counts.set(name, { visits: (row?.visits ?? 0) + 1, last: i });
  });
  let best: { name: string; visits: number; last: number } | null = null;
  for (const [name, row] of counts) {
    if (!best || row.visits > best.visits || (row.visits === best.visits && row.last > best.last)) {
      best = { name, ...row };
    }
  }
  return best && best.visits >= 2 ? { name: best.name, visits: best.visits } : null;
}
