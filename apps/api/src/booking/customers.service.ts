import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, forbidden, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { Customer, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateCustomerInput,
  ListCustomersQuery,
  UpdateCustomerInput,
} from './booking.schemas';
import type { CustomerDetailResponse, CustomerResponse } from './booking.responses';

export type { CustomerDetailResponse, CustomerResponse } from './booking.responses';

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
    const rows = await this.prisma.customer.findMany({
      // Erased clients (task 21) are not listed; their visits still show in the calendar.
      where: {
        AND: [
          await this.visibleTo(m, null),
          search,
          { anonymizedAt: null },
          query.inactiveDays ? this.inactiveSince(m, query.inactiveDays) : {},
        ],
      },
      orderBy: { name: 'asc' },
      take: query.limit,
    });
    return rows.map((c) => toCustomer(c, m));
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
    const [byStatus, upcoming, dates, paid] = await Promise.all([
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
    anonymizedAt: c.anonymizedAt?.toISOString() ?? null,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
  };
}
