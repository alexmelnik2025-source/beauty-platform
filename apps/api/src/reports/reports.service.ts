import { Injectable } from '@nestjs/common';
import { forbidden } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, datesBetween, instantToLocal, zonedToInstant } from '../scheduling/time';
import type { Location } from '../generated/prisma/client';
import type { SalonReport } from './reports.responses';
import type { ReportQuery } from './reports.schemas';
import { visitsCsv, type CsvLocale } from './visits-csv';

interface Counts {
  completed: number;
  noShow: number;
  revenueGrosze: number;
  paid: number;
}

const emptyCounts = (): Counts => ({ completed: 0, noShow: 0, revenueGrosze: 0, paid: 0 });

const byRevenue = <T extends Counts & { name: string }>(a: T, b: T): number =>
  b.revenueGrosze - a.revenueGrosze || b.completed - a.completed || a.name.localeCompare(b.name);

/**
 * Task 14: the salon owner's report for a period (the salon's own dates).
 *
 * Owners and managers of the location see the whole salon. A specialist sees only
 * their own visits, and only with "viewOwnEarnings" (prices and own results);
 * without it the report is refused. Held and expired slots never count. Revenue is
 * what paid visits brought: the visit price minus loyalty discounts.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  async get(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ReportQuery,
  ): Promise<SalonReport> {
    const { location, staffIds, own, rangeStart, rangeEnd } = await this.scope(
      m,
      userId,
      locationId,
      query,
    );
    const tz = location.timezone;
    const rows = await this.prisma.appointment.findMany({
      where: {
        locationId,
        status: { notIn: ['held', 'expired'] },
        startAt: { gte: rangeStart, lt: rangeEnd },
        ...(staffIds ? { staffId: { in: staffIds } } : {}),
      },
      select: {
        status: true,
        source: true,
        startAt: true,
        priceGrosze: true,
        discountGrosze: true,
        paidAt: true,
        cancelledBy: true,
        customerId: true,
        staff: { select: { id: true, displayName: true } },
        service: { select: { id: true, name: true } },
      },
    });

    const totals = {
      visits: rows.length,
      upcoming: 0,
      ...emptyCounts(),
      cancelledByClient: 0,
      cancelledBySalon: 0,
      online: 0,
      discountGrosze: 0,
      averageTicketGrosze: 0,
      clients: 0,
      newClients: 0,
    };
    const staff = new Map<string, Counts & { id: string; displayName: string; name: string }>();
    const services = new Map<string, Counts & { id: string; name: string }>();
    const days = new Map(
      datesBetween(query.from, query.to).map((date) => [
        date,
        { date, completed: 0, revenueGrosze: 0 },
      ]),
    );
    const clients = new Set<string>();

    for (const a of rows) {
      const staffRow =
        staff.get(a.staff.id) ??
        staff
          .set(a.staff.id, { ...a.staff, name: a.staff.displayName, ...emptyCounts() })
          .get(a.staff.id)!;
      const serviceRow =
        services.get(a.service.id) ??
        services.set(a.service.id, { ...a.service, ...emptyCounts() }).get(a.service.id)!;
      const day = days.get(instantToLocal(a.startAt.getTime(), tz).date);
      const targets: Counts[] = [totals, staffRow, serviceRow];

      if (a.status === 'cancelled') {
        if (a.cancelledBy === 'customer') totals.cancelledByClient++;
        else totals.cancelledBySalon++;
        continue;
      }
      if (a.source === 'online') totals.online++;
      if (a.status === 'confirmed') totals.upcoming++;
      if (a.status === 'no_show') {
        for (const t of targets) t.noShow++;
      }
      if (a.status === 'completed') {
        for (const t of targets) t.completed++;
        if (day) day.completed++;
        if (a.customerId) clients.add(a.customerId);
        if (a.paidAt) {
          const paid = a.priceGrosze - a.discountGrosze;
          for (const t of targets) {
            t.paid++;
            t.revenueGrosze += paid;
          }
          totals.discountGrosze += a.discountGrosze;
          if (day) day.revenueGrosze += paid;
        }
      }
    }

    totals.clients = clients.size;
    totals.averageTicketGrosze =
      totals.paid > 0 ? Math.round(totals.revenueGrosze / totals.paid) : 0;
    if (clients.size > 0) {
      // A client is new when their first visit that took place at this salon is in the period.
      const earlier = await this.prisma.appointment.findMany({
        where: {
          locationId,
          status: 'completed',
          customerId: { in: [...clients] },
          startAt: { lt: rangeStart },
        },
        select: { customerId: true },
        distinct: ['customerId'],
      });
      totals.newClients = clients.size - earlier.length;
    }

    return {
      location: { id: location.id, name: location.name, timezone: tz, currency: location.currency },
      from: query.from,
      to: query.to,
      scope: own ? 'own' : 'location',
      totals,
      staff: [...staff.values()]
        .sort(byRevenue)
        .map(({ id, displayName, completed, noShow, revenueGrosze, paid }) => ({
          id,
          displayName,
          completed,
          noShow,
          revenueGrosze,
          paid,
        })),
      services: [...services.values()]
        .sort(byRevenue)
        .map(({ id, name, completed, noShow, revenueGrosze, paid }) => ({
          id,
          name,
          completed,
          noShow,
          revenueGrosze,
          paid,
        })),
      days: [...days.values()],
    };
  }

  /** Task 21: every visit of the period as CSV (same access as the report), oldest first. */
  async visitsCsv(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ReportQuery,
    locale: CsvLocale,
  ): Promise<{ csv: string; fileName: string }> {
    const { location, staffIds, rangeStart, rangeEnd } = await this.scope(
      m,
      userId,
      locationId,
      query,
    );
    const rows = await this.prisma.appointment.findMany({
      where: {
        locationId,
        status: { notIn: ['held', 'expired'] },
        startAt: { gte: rangeStart, lt: rangeEnd },
        ...(staffIds ? { staffId: { in: staffIds } } : {}),
      },
      select: {
        status: true,
        source: true,
        startAt: true,
        priceGrosze: true,
        discountGrosze: true,
        paidAt: true,
        cancelledBy: true,
        customer: { select: { name: true } },
        staff: { select: { displayName: true } },
        service: { select: { name: true } },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });
    const csv = visitsCsv(
      rows.map((a) => {
        const local = instantToLocal(a.startAt.getTime(), location.timezone);
        return {
          date: local.date,
          time: local.time,
          staff: a.staff.displayName,
          service: a.service.name,
          client: a.customer?.name ?? null,
          status: a.status as 'confirmed' | 'completed' | 'no_show' | 'cancelled',
          cancelledBy: a.cancelledBy,
          online: a.source === 'online',
          priceGrosze: a.priceGrosze,
          discountGrosze: a.discountGrosze,
          paid: a.paidAt !== null,
        };
      }),
      locale,
    );
    return { csv, fileName: `visits-${location.slug}-${query.from}-${query.to}.csv` };
  }

  /**
   * Who sees what: owners and managers the whole location; a specialist only their own visits,
   * and only with "viewOwnEarnings". The period in the salon's own dates.
   */
  private async scope(
    m: MembershipContext,
    userId: string,
    locationId: string,
    query: ReportQuery,
  ): Promise<{
    location: Location;
    staffIds: string[] | null;
    own: boolean;
    rangeStart: Date;
    rangeEnd: Date;
  }> {
    const location = await this.access.readable(m, locationId);
    const own = m.role === 'staff';
    if (own && !m.permissions.viewOwnEarnings) {
      throw forbidden();
    }
    let staffIds: string[] | null = null;
    if (own) {
      const mine = await this.prisma.staffMember.findMany({
        where: { locationId, userId },
        select: { id: true },
      });
      staffIds = mine.map((s) => s.id);
    }
    return {
      location,
      staffIds,
      own,
      rangeStart: new Date(zonedToInstant(query.from, 0, location.timezone)),
      rangeEnd: new Date(zonedToInstant(addDays(query.to, 1), 0, location.timezone)),
    };
  }
}
