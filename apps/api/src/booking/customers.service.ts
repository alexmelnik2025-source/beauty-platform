import { Injectable } from '@nestjs/common';
import { notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ListCustomersQuery } from './booking.schemas';

export interface CustomerResponse {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  locale: string;
  createdAt: string;
}

export interface CustomerDetailResponse extends CustomerResponse {
  marketingConsent: boolean;
  visits: {
    id: string;
    locationId: string;
    start: string;
    status: string;
    serviceName: string;
    staffName: string;
  }[];
}

/**
 * Clients belong to the organization. Owners see all of them; managers and staff
 * see clients who have (had) appointments in their locations.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(m: MembershipContext, query: ListCustomersQuery): Promise<CustomerResponse[]> {
    const search = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { phone: { contains: query.search.replace(/\s/g, '') } },
            { email: { contains: query.search.toLowerCase() } },
          ],
        }
      : {};
    const rows = await this.prisma.customer.findMany({
      where: { ...this.visibleTo(m), ...search },
      orderBy: { name: 'asc' },
      take: query.limit,
    });
    return rows.map(toCustomer);
  }

  async get(m: MembershipContext, customerId: string): Promise<CustomerDetailResponse> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, ...this.visibleTo(m) },
      include: {
        consents: { where: { type: 'marketing' }, orderBy: { createdAt: 'desc' }, take: 1 },
        appointments: {
          where: {
            status: { notIn: ['held', 'expired'] },
            ...(m.role === 'owner' ? {} : { locationId: { in: m.locationIds } }),
          },
          include: { service: true, staff: true },
          orderBy: { startAt: 'desc' },
          take: 100,
        },
      },
    });
    if (!customer) throw notFound('Customer');
    return {
      ...toCustomer(customer),
      marketingConsent: customer.consents[0]?.granted ?? false,
      visits: customer.appointments.map((a) => ({
        id: a.id,
        locationId: a.locationId,
        start: a.startAt.toISOString(),
        status: a.status,
        serviceName: a.service.name,
        staffName: a.staff.displayName,
      })),
    };
  }

  private visibleTo(m: MembershipContext): Prisma.CustomerWhereInput {
    return {
      organizationId: m.organizationId,
      ...(m.role === 'owner'
        ? {}
        : { appointments: { some: { locationId: { in: m.locationIds } } } }),
    };
  }
}

function toCustomer(c: {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  locale: string;
  createdAt: Date;
}): CustomerResponse {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    locale: c.locale,
    createdAt: c.createdAt.toISOString(),
  };
}
