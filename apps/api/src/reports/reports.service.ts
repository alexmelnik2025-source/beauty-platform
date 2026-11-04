import { Injectable } from '@nestjs/common';
import type { MembershipContext } from '../common/request-context';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, datesBetween, instantToLocal, zonedToInstant } from '../scheduling/time';
import type { SalonReportResponse } from './reports.responses';
import type { ReportQuery } from './reports.schemas';

interface Tally {
  completed: number;
  noShow: number;
  paidVisits: number;
  revenueGrosze: number;
}

const tally = (): Tally => ({ completed: 0, noShow: 0, paidVisits: 0, revenueGrosze: 0 });

/**
 * Reports for the salon owner (task 14): what happened at a location between two local days —
 * visits, no-shows, cancellations, what the clients paid, by staff member, service and day.
 * Counted from the visits themselves, so a report is always up to date.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  async summary(
    m: MembershipContext,
    locationId: string,
    query: ReportQuery,
  ): Promise<SalonReportResponse> {
    const location = await this.access.readable(m, locationId);
    const tz = location.timezone;
    const start = new Date(zonedToInstant(query.from, 0, tz));
    const end = new Date(zonedToInstant(addDays(query.to, 1), 0, tz));
    const rows = await this.prisma.appointment.findMany({
      where: {
        locationId,
        startAt: { gte: start, lt: end },
        status: { notIn: ['held', 'expired'] },
      },
      select: {
        status: true,
        cancelledBy: true,
        source: true,
        staffId: true,
        serviceId: true,
        customerId: true,
        startAt: true,
        priceGrosze: true,
        discountGrosze: true,
        paidAt: true,
      },
    });

    const totals = {
      appointments: rows.length,
      completed: 0,
      noShow: 0,
      cancelledByClient: 0,
      cancelledBySalon: 0,
      upcoming: 0,
      online: 0,
      paidVisits: 0,
      revenueGrosze: 0,
      discountGrosze: 0,
    };
    const byStaff = new Map<string, Tally>();
    const byService = new Map<string, Tally>();
    const byDay = new Map<string, { completed: number; revenueGrosze: number }>(
      datesBetween(query.from, query.to).map((d) => [d, { completed: 0, revenueGrosze: 0 }]),
    );
    const clients = new Set<string>();

    for (const a of rows) {
      if (a.source === 'online') totals.online++;
      const staff = byStaff.get(a.staffId) ?? tally();
      const service = byService.get(a.serviceId) ?? tally();
      const day = byDay.get(instantToLocal(a.startAt.getTime(), tz).date);
      if (a.status === 'cancelled') {
        if (a.cancelledBy === 'customer') totals.cancelledByClient++;
        else totals.cancelledBySalon++;
        continue;
      }
      byStaff.set(a.staffId, staff);
      byService.set(a.serviceId, service);
      if (a.status === 'confirmed') {
        totals.upcoming++;
      } else if (a.status === 'no_show') {
        totals.noShow++;
        staff.noShow++;
        service.noShow++;
      } else if (a.status === 'completed') {
        totals.completed++;
        staff.completed++;
        service.completed++;
        if (day) day.completed++;
        if (a.customerId) clients.add(a.customerId);
        if (a.paidAt) {
          const paid = a.priceGrosze - a.discountGrosze;
          totals.paidVisits++;
          totals.revenueGrosze += paid;
          totals.discountGrosze += a.discountGrosze;
          staff.paidVisits++;
          staff.revenueGrosze += paid;
          service.paidVisits++;
          service.revenueGrosze += paid;
          if (day) day.revenueGrosze += paid;
        }
      }
    }

    // New clients: their first visit they came to at this salon (any location) is in the period.
    const firsts = clients.size
      ? await this.prisma.appointment.groupBy({
          by: ['customerId'],
          where: {
            customerId: { in: [...clients] },
            status: 'completed',
            location: { organizationId: location.organizationId },
          },
          _min: { startAt: true },
        })
      : [];
    const newClients = firsts.filter((f) => f._min.startAt && f._min.startAt >= start).length;

    const [staffRows, serviceRows] = await Promise.all([
      this.prisma.staffMember.findMany({
        where: { id: { in: [...byStaff.keys()] } },
        select: { id: true, displayName: true },
      }),
      this.prisma.service.findMany({
        where: { id: { in: [...byService.keys()] } },
        select: { id: true, name: true },
      }),
    ]);
    const staffName = new Map(staffRows.map((s) => [s.id, s.displayName]));
    const serviceName = new Map(serviceRows.map((s) => [s.id, s.name]));
    const mostPaid = (a: Tally, b: Tally) =>
      b.revenueGrosze - a.revenueGrosze || b.completed - a.completed;
    const decided = totals.completed + totals.noShow;

    return {
      from: query.from,
      to: query.to,
      currency: location.currency,
      totals: {
        ...totals,
        averageTicketGrosze: totals.paidVisits
          ? Math.floor(totals.revenueGrosze / totals.paidVisits)
          : null,
        noShowPercent: decided ? Math.round((totals.noShow * 100) / decided) : null,
        clients: clients.size,
        newClients,
      },
      byStaff: [...byStaff.entries()]
        .sort(([, a], [, b]) => mostPaid(a, b))
        .map(([staffId, t]) => ({ staffId, displayName: staffName.get(staffId) ?? '', ...t })),
      byService: [...byService.entries()]
        .sort(([, a], [, b]) => mostPaid(a, b))
        .map(([serviceId, t]) => ({
          serviceId,
          name: serviceName.get(serviceId) ?? '',
          completed: t.completed,
          paidVisits: t.paidVisits,
          revenueGrosze: t.revenueGrosze,
        })),
      byDay: [...byDay.entries()].map(([date, d]) => ({ date, ...d })),
    };
  }
}
