import { Injectable } from '@nestjs/common';
import { forbidden } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDays,
  datesBetween,
  daysBetween,
  instantToLocal,
  isoWeekday,
  zonedToInstant,
} from '../scheduling/time';
import type { Location, PaymentMethod } from '../generated/prisma/client';
import type { InstantRange, LocalInterval } from '../scheduling/slots';
import { occupancy, occupancyPercent } from './occupancy';
import type { SalonReport } from './reports.responses';
import type { ReportQuery } from './reports.schemas';
import { visitsCsv, type CsvLocale } from './visits-csv';

/** Task 227: a payment method, or "unknown" when the staff did not say. */
type PaymentKey = PaymentMethod | 'unknown';

interface Counts {
  completed: number;
  noShow: number;
  revenueGrosze: number;
  paid: number;
  cancelledByClient: number;
  cancelledBySalon: number;
}

const emptyCounts = (): Counts => ({
  completed: 0,
  noShow: 0,
  revenueGrosze: 0,
  paid: 0,
  cancelledByClient: 0,
  cancelledBySalon: 0,
});

const LEAD_BUCKETS = ['sameDay', 'nextDay', 'week', 'twoWeeks', 'later'] as const;

/**
 * Task 260: how far ahead the visits of the period were booked — days between the booking and the
 * visit in the salon's own dates. Cancelled visits and entries made after the visit began (the
 * salon writing down a walk-in or a past visit) do not count.
 */
export function leadTime(
  rows: { status: string; source: string; startAt: Date; createdAt: Date }[],
  tz: string,
): SalonReport['leadTime'] {
  const buckets = new Map<
    (typeof LEAD_BUCKETS)[number],
    { key: (typeof LEAD_BUCKETS)[number]; visits: number; online: number }
  >(LEAD_BUCKETS.map((key) => [key, { key, visits: 0, online: 0 }]));
  const days: number[] = [];
  for (const a of rows) {
    if (a.status === 'cancelled' || a.createdAt >= a.startAt) continue;
    const ahead = Math.round(
      (Date.parse(instantToLocal(a.startAt.getTime(), tz).date) -
        Date.parse(instantToLocal(a.createdAt.getTime(), tz).date)) /
        86_400_000,
    );
    days.push(ahead);
    const key =
      ahead <= 0
        ? 'sameDay'
        : ahead === 1
          ? 'nextDay'
          : ahead <= 7
            ? 'week'
            : ahead <= 14
              ? 'twoWeeks'
              : 'later';
    const bucket = buckets.get(key)!;
    bucket.visits++;
    if (a.source === 'online') bucket.online++;
  }
  days.sort((x, y) => x - y);
  const mid = Math.floor(days.length / 2);
  return {
    visits: days.length,
    medianDays:
      days.length === 0
        ? null
        : Math.round(days.length % 2 === 1 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2),
    buckets: [...buckets.values()],
  };
}

const byRevenue = <T extends Counts & { name: string | null }>(a: T, b: T): number =>
  b.revenueGrosze - a.revenueGrosze ||
  b.completed - a.completed ||
  (a.name ?? '').localeCompare(b.name ?? '');

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
        createdAt: true,
        priceGrosze: true,
        discountGrosze: true,
        paidAt: true,
        paymentMethod: true,
        tipGrosze: true,
        cancelledBy: true,
        customerId: true,
        staff: { select: { id: true, displayName: true } },
        service: {
          select: { id: true, name: true, category: { select: { id: true, name: true } } },
        },
      },
    });

    const totals = {
      visits: rows.length,
      upcoming: 0,
      ...emptyCounts(),
      online: 0,
      discountGrosze: 0,
      averageTicketGrosze: 0,
      clients: 0,
      newClients: 0,
    };
    const staff = new Map<string, Counts & { id: string; displayName: string; name: string }>();
    const services = new Map<string, Counts & { id: string; name: string }>();
    // Task 256: the same by price-list category; '' = services without a category.
    const categories = new Map<string, Counts & { id: string | null; name: string | null }>();
    const days = new Map(
      datesBetween(query.from, query.to).map((date) => [
        date,
        { date, completed: 0, revenueGrosze: 0 },
      ]),
    );
    const clients = new Set<string>();
    const payments = new Map<
      PaymentKey,
      { method: PaymentKey; paid: number; revenueGrosze: number }
    >();
    const busy = new Map<string, { weekday: number; hour: number; visits: number }>();
    // Task 229: tips of the visits that took place — by specialist; not part of the revenue.
    const tips = { totalGrosze: 0, visits: 0 };
    const tipsByStaff = new Map<
      string,
      { id: string; displayName: string; tipsGrosze: number; visits: number }
    >();
    const byClient = new Map<string, { completed: number; revenueGrosze: number }>();
    const lastVisit = new Map<
      string,
      { startAt: Date; staff: { id: string; displayName: string } }
    >();
    const weekdays = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      completed: 0,
      noShow: 0,
      revenueGrosze: 0,
    }));

    for (const a of rows) {
      const staffRow =
        staff.get(a.staff.id) ??
        staff
          .set(a.staff.id, { ...a.staff, name: a.staff.displayName, ...emptyCounts() })
          .get(a.staff.id)!;
      const serviceRow =
        services.get(a.service.id) ??
        services
          .set(a.service.id, { id: a.service.id, name: a.service.name, ...emptyCounts() })
          .get(a.service.id)!;
      const category = a.service.category;
      const categoryKey = category?.id ?? '';
      const categoryRow =
        categories.get(categoryKey) ??
        categories
          .set(categoryKey, {
            id: category?.id ?? null,
            name: category?.name ?? null,
            ...emptyCounts(),
          })
          .get(categoryKey)!;
      const localDate = instantToLocal(a.startAt.getTime(), tz).date;
      const day = days.get(localDate);
      const weekday = weekdays[isoWeekday(localDate) - 1]!;
      const targets: Counts[] = [totals, staffRow, serviceRow, categoryRow];

      if (a.status === 'cancelled') {
        for (const t of targets) {
          if (a.cancelledBy === 'customer') t.cancelledByClient++;
          else t.cancelledBySalon++;
        }
        continue;
      }
      const hour = Math.floor(instantToLocal(a.startAt.getTime(), tz).minute / 60);
      const cellKey = `${weekday.weekday}-${hour}`;
      const cell =
        busy.get(cellKey) ??
        busy.set(cellKey, { weekday: weekday.weekday, hour, visits: 0 }).get(cellKey)!;
      cell.visits++;
      if (a.source === 'online') totals.online++;
      if (a.status === 'confirmed') totals.upcoming++;
      if (a.status === 'no_show') {
        for (const t of targets) t.noShow++;
        weekday.noShow++;
      }
      if (a.status === 'completed') {
        for (const t of targets) t.completed++;
        if (day) day.completed++;
        weekday.completed++;
        const client = a.customerId
          ? (byClient.get(a.customerId) ??
            byClient.set(a.customerId, { completed: 0, revenueGrosze: 0 }).get(a.customerId)!)
          : null;
        if (a.customerId) {
          clients.add(a.customerId);
          const last = lastVisit.get(a.customerId);
          if (!last || a.startAt > last.startAt) {
            lastVisit.set(a.customerId, { startAt: a.startAt, staff: a.staff });
          }
        }
        if (client) client.completed++;
        if (a.tipGrosze > 0) {
          tips.totalGrosze += a.tipGrosze;
          tips.visits++;
          const tipRow =
            tipsByStaff.get(a.staff.id) ??
            tipsByStaff.set(a.staff.id, { ...a.staff, tipsGrosze: 0, visits: 0 }).get(a.staff.id)!;
          tipRow.tipsGrosze += a.tipGrosze;
          tipRow.visits++;
        }
        if (a.paidAt) {
          const paid = a.priceGrosze - a.discountGrosze;
          if (client) client.revenueGrosze += paid;
          for (const t of targets) {
            t.paid++;
            t.revenueGrosze += paid;
          }
          totals.discountGrosze += a.discountGrosze;
          const method: PaymentKey = a.paymentMethod ?? 'unknown';
          const payment =
            payments.get(method) ??
            payments.set(method, { method, paid: 0, revenueGrosze: 0 }).get(method)!;
          payment.paid++;
          payment.revenueGrosze += paid;
          if (day) day.revenueGrosze += paid;
          weekday.revenueGrosze += paid;
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
        .map(
          ({
            id,
            displayName,
            completed,
            noShow,
            revenueGrosze,
            paid,
            cancelledByClient,
            cancelledBySalon,
          }) => ({
            id,
            displayName,
            completed,
            noShow,
            revenueGrosze,
            paid,
            cancelledByClient,
            cancelledBySalon,
          }),
        ),
      services: [...services.values()]
        .sort(byRevenue)
        .map(
          ({
            id,
            name,
            completed,
            noShow,
            revenueGrosze,
            paid,
            cancelledByClient,
            cancelledBySalon,
          }) => ({
            id,
            name,
            completed,
            noShow,
            revenueGrosze,
            paid,
            cancelledByClient,
            cancelledBySalon,
          }),
        ),
      // Task 256: only when the price list is grouped — a single "no category" row says nothing.
      categories: [...categories.values()].some((c) => c.id !== null)
        ? [...categories.values()]
            .sort(byRevenue)
            .map(
              ({
                id,
                name,
                completed,
                noShow,
                revenueGrosze,
                paid,
                cancelledByClient,
                cancelledBySalon,
              }) => ({
                id,
                name,
                completed,
                noShow,
                revenueGrosze,
                paid,
                cancelledByClient,
                cancelledBySalon,
              }),
            )
        : [],
      days: [...days.values()],
      // Task 227: how the paid visits were paid, most money first; "unknown" (not said) last.
      payments: [...payments.values()].sort(
        (x, y) =>
          Number(x.method === 'unknown') - Number(y.method === 'unknown') ||
          y.revenueGrosze - x.revenueGrosze ||
          y.paid - x.paid,
      ),
      tips: {
        ...tips,
        staff: [...tipsByStaff.values()].sort(
          (x, y) =>
            y.tipsGrosze - x.tipsGrosze ||
            y.visits - x.visits ||
            x.displayName.localeCompare(y.displayName),
        ),
      },
      weekdays,
      tillCloses: await this.tillCloses(locationId, own, query),
      previous: await this.previous(locationId, staffIds, tz, query),
      occupancy: await this.occupancy(locationId, staffIds, tz, query, rangeStart, rangeEnd),
      ratings: await this.ratings(locationId, staffIds, rangeStart, rangeEnd),
      rebooking: await this.rebooking(locationId, lastVisit),
      topClients: own ? [] : await this.topClients(byClient),
      unbookedServices: own ? [] : await this.unbookedServices(locationId, rows, rangeEnd),
      leadTime: leadTime(rows, tz),
      marketing: await this.marketing(own ? new Set() : clients, rangeStart, rangeEnd),
      busyHours: [...busy.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
      newcomers: await this.newcomers(locationId, staffIds, tz, clients, rangeStart),
      returnInterval: await this.returnInterval(locationId, staffIds, tz, clients, rangeStart),
    };
  }

  /**
   * Task 247: "Co ile dni wracają klienci" — for the clients who came in the period, the days
   * between two visits in a row that took place (on different days), where the later one is in the
   * period: the average and the median. By the specialist of the later visit (in a specialist's
   * own report — only her visits). Counts only.
   */
  private async returnInterval(
    locationId: string,
    staffIds: string[] | null,
    tz: string,
    clients: Set<string>,
    rangeStart: Date,
  ): Promise<SalonReport['returnInterval']> {
    const all: number[] = [];
    const byStaff = new Map<string, { id: string; displayName: string; days: number[] }>();
    if (clients.size > 0) {
      const visits = await this.prisma.appointment.findMany({
        where: { locationId, customerId: { in: [...clients] }, status: 'completed' },
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        select: {
          customerId: true,
          startAt: true,
          staff: { select: { id: true, displayName: true } },
        },
      });
      const previousDay = new Map<string, string>();
      for (const a of visits) {
        if (!a.customerId) continue;
        const day = instantToLocal(a.startAt.getTime(), tz).date;
        const before = previousDay.get(a.customerId);
        previousDay.set(a.customerId, day);
        if (!before || before === day || a.startAt < rangeStart) continue;
        if (staffIds && !staffIds.includes(a.staff.id)) continue;
        const days = daysBetween(before, day);
        all.push(days);
        const row =
          byStaff.get(a.staff.id) ??
          byStaff.set(a.staff.id, { ...a.staff, days: [] }).get(a.staff.id)!;
        row.days.push(days);
      }
    }
    const summary = (days: number[]) => {
      if (days.length === 0) return { intervals: 0, averageDays: 0, medianDays: 0 };
      const sorted = [...days].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      return {
        intervals: days.length,
        averageDays: Math.round(days.reduce((sum, d) => sum + d, 0) / days.length),
        medianDays: Math.round(median),
      };
    };
    return {
      ...summary(all),
      staff: [...byStaff.values()]
        .map(({ id, displayName, days }) => ({ id, displayName, ...summary(days) }))
        .sort((a, b) => b.intervals - a.intervals || a.displayName.localeCompare(b.displayName)),
    };
  }

  /**
   * Task 246: "Nowi klienci — czy wrócili" — of the clients whose first visit at this salon took
   * place in the period, how many came again on a later day (any specialist) and how many of the
   * rest have a visit booked for a later day. By specialist: the one of that first visit (in a specialist's
   * own report — only clients whose first visit was hers). Counts only.
   */
  private async newcomers(
    locationId: string,
    staffIds: string[] | null,
    tz: string,
    clients: Set<string>,
    rangeStart: Date,
  ): Promise<SalonReport['newcomers']> {
    const empty = { clients: 0, returned: 0, booked: 0, percent: 0, staff: [] };
    if (clients.size === 0) return empty;
    const visits = await this.prisma.appointment.findMany({
      where: {
        locationId,
        customerId: { in: [...clients] },
        status: { in: ['confirmed', 'completed'] },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      select: {
        customerId: true,
        status: true,
        startAt: true,
        staff: { select: { id: true, displayName: true } },
      },
    });
    const firstVisit = new Map<
      string,
      { startAt: Date; staff: { id: string; displayName: string } }
    >();
    for (const a of visits) {
      if (a.customerId && a.status === 'completed' && !firstVisit.has(a.customerId)) {
        firstVisit.set(a.customerId, { startAt: a.startAt, staff: a.staff });
      }
    }
    for (const [customerId, first] of firstVisit) {
      if (first.startAt < rangeStart || (staffIds && !staffIds.includes(first.staff.id))) {
        firstVisit.delete(customerId);
      }
    }
    if (firstVisit.size === 0) return empty;
    const came = new Set<string>();
    const hasBooking = new Set<string>();
    const day = (at: Date) => instantToLocal(at.getTime(), tz).date;
    for (const a of visits) {
      const first = a.customerId ? firstVisit.get(a.customerId) : undefined;
      // A second service on the same day is the same visit, not a return.
      if (!a.customerId || !first || day(a.startAt) <= day(first.startAt)) continue;
      if (a.status === 'completed') came.add(a.customerId);
      else hasBooking.add(a.customerId);
    }
    const staff = new Map<
      string,
      { id: string; displayName: string; clients: number; returned: number; booked: number }
    >();
    let returned = 0;
    let booked = 0;
    for (const [customerId, first] of firstVisit) {
      const row =
        staff.get(first.staff.id) ??
        staff
          .set(first.staff.id, { ...first.staff, clients: 0, returned: 0, booked: 0 })
          .get(first.staff.id)!;
      row.clients++;
      if (came.has(customerId)) {
        returned++;
        row.returned++;
      } else if (hasBooking.has(customerId)) {
        booked++;
        row.booked++;
      }
    }
    return {
      clients: firstVisit.size,
      returned,
      booked,
      percent: Math.round(((returned + booked) / firstVisit.size) * 100),
      staff: [...staff.values()].sort(
        (a, b) => b.clients - a.clients || a.displayName.localeCompare(b.displayName),
      ),
    };
  }

  /**
   * Task 218: "Kolejna wizyta" — of the clients who came in the period, how many have a later
   * visit at this salon (booked, came or did not come; any specialist) after their last visit of
   * the period. By specialist: the one of that last visit. Counts only, no names.
   */
  private async rebooking(
    locationId: string,
    lastVisit: Map<string, { startAt: Date; staff: { id: string; displayName: string } }>,
  ): Promise<SalonReport['rebooking']> {
    const percent = (part: number, whole: number) =>
      whole > 0 ? Math.round((part / whole) * 100) : 0;
    if (lastVisit.size === 0) return { clients: 0, rebooked: 0, percent: 0, staff: [] };
    const latest = new Map(
      (
        await this.prisma.appointment.groupBy({
          by: ['customerId'],
          where: {
            locationId,
            customerId: { in: [...lastVisit.keys()] },
            status: { in: ['confirmed', 'completed', 'no_show'] },
          },
          _max: { startAt: true },
        })
      ).map((g) => [g.customerId, g._max.startAt]),
    );
    const staff = new Map<
      string,
      { id: string; displayName: string; clients: number; rebooked: number }
    >();
    let rebooked = 0;
    for (const [customerId, last] of lastVisit) {
      const row =
        staff.get(last.staff.id) ??
        staff.set(last.staff.id, { ...last.staff, clients: 0, rebooked: 0 }).get(last.staff.id)!;
      row.clients++;
      const next = latest.get(customerId);
      if (next && next > last.startAt) {
        rebooked++;
        row.rebooked++;
      }
    }
    return {
      clients: lastVisit.size,
      rebooked,
      percent: percent(rebooked, lastVisit.size),
      staff: [...staff.values()]
        .map((s) => ({ ...s, percent: percent(s.rebooked, s.clients) }))
        .sort(
          (a, b) =>
            b.clients - a.clients ||
            b.percent - a.percent ||
            a.displayName.localeCompare(b.displayName),
        ),
    };
  }

  /**
   * Task 244: "Zgody na wiadomości" — of the clients who came in the period, how many may get the
   * salon's messages now (their latest marketing answer is "yes"), how many said "yes" for the
   * first time in the period, and how many said "no" later (unsubscribed). Counts only, no names;
   * not in a specialist's own report — consents belong with the client's contacts.
   */
  private async marketing(
    clients: Set<string>,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<SalonReport['marketing']> {
    if (clients.size === 0) {
      return { clients: 0, consented: 0, percent: 0, newInPeriod: 0, unsubscribed: 0 };
    }
    const records = await this.prisma.consentRecord.findMany({
      where: { customerId: { in: [...clients] }, type: 'marketing' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { customerId: true, granted: true, createdAt: true },
    });
    const byClient = new Map<string, { firstYes: Date | null; latest: boolean }>();
    for (const r of records) {
      const row = byClient.get(r.customerId) ?? { firstYes: null, latest: false };
      if (r.granted && !row.firstYes) row.firstYes = r.createdAt;
      row.latest = r.granted;
      byClient.set(r.customerId, row);
    }
    let consented = 0;
    let newInPeriod = 0;
    let unsubscribed = 0;
    for (const row of byClient.values()) {
      if (!row.latest) {
        if (row.firstYes) unsubscribed++;
        continue;
      }
      consented++;
      if (row.firstYes && row.firstYes >= rangeStart && row.firstYes < rangeEnd) newInPeriod++;
    }
    return {
      clients: clients.size,
      consented,
      percent: Math.round((consented / clients.size) * 100),
      newInPeriod,
      unsubscribed,
    };
  }

  /**
   * Task 259: "Usługi bez wizyt" — services clients can book (active) that nobody booked in the
   * period: no visit that was not cancelled. Services added after the period are left out.
   * In price-list order (category, then service). Not in a specialist's own report: the price
   * list is the owner's.
   */
  private async unbookedServices(
    locationId: string,
    rows: { status: string; service: { id: string } }[],
    rangeEnd: Date,
  ): Promise<SalonReport['unbookedServices']> {
    const booked = new Set(rows.filter((a) => a.status !== 'cancelled').map((a) => a.service.id));
    const services = await this.prisma.service.findMany({
      where: { locationId, active: true, createdAt: { lt: rangeEnd } },
      select: {
        id: true,
        name: true,
        priceGrosze: true,
        sortOrder: true,
        createdAt: true,
        category: { select: { name: true, sortOrder: true } },
      },
    });
    return services
      .filter((s) => !booked.has(s.id))
      .sort(
        (a, b) =>
          // Services without a category after the grouped ones, as on the booking page.
          Number(a.category === null) - Number(b.category === null) ||
          (a.category?.sortOrder ?? 0) - (b.category?.sortOrder ?? 0) ||
          (a.category?.name ?? '').localeCompare(b.category?.name ?? '') ||
          a.sortOrder - b.sortOrder ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((s) => ({
        id: s.id,
        name: s.name,
        categoryName: s.category?.name ?? null,
        priceGrosze: s.priceGrosze,
      }));
  }

  /**
   * Task 215: "Najlepsi klienci" — up to 10 clients who brought the most (then came most often),
   * by name only. Not in a specialist's own report: the salon's clients are the owner's.
   */
  private async topClients(
    byClient: Map<string, { completed: number; revenueGrosze: number }>,
  ): Promise<SalonReport['topClients']> {
    const top = [...byClient.entries()]
      .sort(([, a], [, b]) => b.revenueGrosze - a.revenueGrosze || b.completed - a.completed)
      .slice(0, 10);
    if (top.length === 0) return [];
    const names = new Map(
      (
        await this.prisma.customer.findMany({
          where: { id: { in: top.map(([id]) => id) } },
          select: { id: true, name: true },
        })
      ).map((c) => [c.id, c.name]),
    );
    return top
      .map(([id, counts]) => ({ id, name: names.get(id) ?? '', ...counts }))
      .sort(
        (a, b) =>
          b.revenueGrosze - a.revenueGrosze ||
          b.completed - a.completed ||
          a.name.localeCompare(b.name),
      );
  }

  /**
   * Task 213: "Oceny" — the reviews clients left for the visits of the period (by the visit's
   * day, so a review written later still counts for the month of the visit). A specialist with
   * their own report sees only the reviews of their own visits, as on "Opinie".
   */
  private async ratings(
    locationId: string,
    staffIds: string[] | null,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<SalonReport['ratings']> {
    const rows = await this.prisma.visitReview.findMany({
      where: {
        locationId,
        appointment: { startAt: { gte: rangeStart, lt: rangeEnd } },
        ...(staffIds ? { staffId: { in: staffIds } } : {}),
      },
      select: { rating: true, staff: { select: { id: true, displayName: true } } },
    });
    const oneDecimal = (sum: number, count: number) => Math.round((sum / count) * 10) / 10;
    const stars = [0, 0, 0, 0, 0];
    const staff = new Map<
      string,
      { id: string; displayName: string; sum: number; reviews: number }
    >();
    let sum = 0;
    for (const r of rows) {
      const rating = Math.min(5, Math.max(1, r.rating));
      stars[rating - 1]!++;
      sum += rating;
      const row =
        staff.get(r.staff.id) ??
        staff.set(r.staff.id, { ...r.staff, sum: 0, reviews: 0 }).get(r.staff.id)!;
      row.sum += rating;
      row.reviews++;
    }
    return {
      reviews: rows.length,
      average: rows.length > 0 ? oneDecimal(sum, rows.length) : null,
      stars,
      staff: [...staff.values()]
        .map(({ id, displayName, sum: total, reviews }) => ({
          id,
          displayName,
          reviews,
          average: oneDecimal(total, reviews),
        }))
        .sort(
          (a, b) =>
            b.average - a.average ||
            b.reviews - a.reviews ||
            a.displayName.localeCompare(b.displayName),
        ),
    };
  }

  /**
   * Task 141: "Obłożenie" — each specialist's working time in the period (weekly hours or
   * special days, minus vacations and blocked time, the same as free times) and the part of it
   * visits took (booked, came or did not come — the time was reserved either way).
   */
  private async occupancy(
    locationId: string,
    staffIds: string[] | null,
    tz: string,
    query: ReportQuery,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<SalonReport['occupancy']> {
    const visits = await this.prisma.appointment.findMany({
      where: {
        locationId,
        status: { in: ['confirmed', 'completed', 'no_show'] },
        startAt: { lt: rangeEnd },
        endAt: { gt: rangeStart },
        ...(staffIds ? { staffId: { in: staffIds } } : {}),
      },
      select: { staffId: true, startAt: true, endAt: true },
    });
    const withVisits = [...new Set(visits.map((v) => v.staffId))];
    const staff = await this.prisma.staffMember.findMany({
      where: {
        locationId,
        ...(staffIds ? { id: { in: staffIds } } : {}),
        OR: [{ active: true }, { id: { in: withVisits } }],
      },
      select: { id: true, displayName: true },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    });
    const ids = staff.map((s) => s.id);
    const [weekly, overrides, timeOff, blocks] = await Promise.all([
      this.prisma.workingHours.findMany({ where: { staffId: { in: ids } } }),
      this.prisma.workingHoursOverride.findMany({
        where: {
          staffId: { in: ids },
          date: {
            gte: new Date(`${query.from}T00:00:00Z`),
            lte: new Date(`${query.to}T00:00:00Z`),
          },
        },
      }),
      this.prisma.timeOff.findMany({
        where: { staffId: { in: ids }, startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      }),
      this.prisma.timeBlock.findMany({
        where: {
          locationId,
          deletedAt: null,
          OR: [{ staffId: { in: ids } }, { staffId: null }],
          startAt: { lt: rangeEnd },
          endAt: { gt: rangeStart },
        },
        select: { staffId: true, startAt: true, endAt: true },
      }),
    ]);

    const rows = staff.map((s) => {
      const week = new Map<number, LocalInterval[]>();
      for (const row of weekly.filter((w) => w.staffId === s.id)) {
        week.set(row.weekday, [...(week.get(row.weekday) ?? []), row]);
      }
      const special = new Map<string, LocalInterval[]>();
      for (const row of overrides.filter((o) => o.staffId === s.id)) {
        const date = row.date.toISOString().slice(0, 10);
        special.set(date, [...(special.get(date) ?? []), row]);
      }
      const away: InstantRange[] = [
        ...timeOff
          .filter((t) => t.staffId === s.id)
          .map((t) => ({ start: t.startsAt.getTime(), end: t.endsAt.getTime() })),
        ...blocks
          .filter((b) => b.staffId === s.id || b.staffId === null)
          .map((b) => ({ start: b.startAt.getTime(), end: b.endAt.getTime() })),
      ];
      const result = occupancy(
        { weekly: week, overrides: special, away },
        visits
          .filter((v) => v.staffId === s.id)
          .map((v) => ({ start: v.startAt.getTime(), end: v.endAt.getTime() })),
        query.from,
        query.to,
        tz,
      );
      return { id: s.id, displayName: s.displayName, ...result, percent: occupancyPercent(result) };
    });

    const total = {
      workMinutes: rows.reduce((sum, r) => sum + r.workMinutes, 0),
      bookedMinutes: rows.reduce((sum, r) => sum + r.bookedMinutes, 0),
    };
    return {
      ...total,
      percent: occupancyPercent(total),
      staff: rows
        .filter((r) => r.workMinutes > 0 || withVisits.includes(r.id))
        .sort((a, b) => b.percent - a.percent || b.bookedMinutes - a.bookedMinutes),
    };
  }

  /**
   * Task 31: the same number of days just before the period, to compare with — "this month so
   * far" (1–4 Nov) is compared with 28–31 Oct. Only what the comparison needs.
   */
  private async previous(
    locationId: string,
    staffIds: string[] | null,
    tz: string,
    query: ReportQuery,
  ): Promise<SalonReport['previous']> {
    const length = datesBetween(query.from, query.to).length;
    const from = addDays(query.from, -length);
    const to = addDays(query.from, -1);
    const rows = await this.prisma.appointment.findMany({
      where: {
        locationId,
        status: { in: ['completed', 'no_show'] },
        startAt: {
          gte: new Date(zonedToInstant(from, 0, tz)),
          lt: new Date(zonedToInstant(query.from, 0, tz)),
        },
        ...(staffIds ? { staffId: { in: staffIds } } : {}),
      },
      select: {
        status: true,
        priceGrosze: true,
        discountGrosze: true,
        paidAt: true,
        customerId: true,
      },
    });
    const clients = new Set<string>();
    const result = { from, to, completed: 0, noShow: 0, paid: 0, revenueGrosze: 0, clients: 0 };
    for (const a of rows) {
      if (a.status === 'no_show') {
        result.noShow++;
        continue;
      }
      result.completed++;
      if (a.customerId) clients.add(a.customerId);
      if (a.paidAt) {
        result.paid++;
        result.revenueGrosze += a.priceGrosze - a.discountGrosze;
      }
    }
    result.clients = clients.size;
    return {
      ...result,
      averageTicketGrosze: result.paid > 0 ? Math.round(result.revenueGrosze / result.paid) : 0,
    };
  }

  /** Task 30: every visit of the period as CSV (same access as the report), oldest first. */
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
        paymentMethod: true,
        tipGrosze: true,
        cancelledBy: true,
        customer: { select: { name: true } },
        staff: { select: { displayName: true } },
        service: { select: { name: true, category: { select: { name: true } } } },
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
          method: a.paymentMethod,
          tipGrosze: a.tipGrosze,
          category: a.service.category?.name ?? null,
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
  /** Task 233: the days of the period whose till was counted (task 232) — not in an own report. */
  private async tillCloses(
    locationId: string,
    own: boolean,
    query: ReportQuery,
  ): Promise<SalonReport['tillCloses']> {
    if (own) return { days: [], differenceGrosze: 0 };
    const rows = await this.prisma.tillClose.findMany({
      where: {
        locationId,
        date: { gte: new Date(`${query.from}T00:00:00Z`), lte: new Date(`${query.to}T00:00:00Z`) },
      },
      orderBy: { date: 'asc' },
    });
    // Task 237: cash put in or taken out on those days (task 236).
    const movements = await this.prisma.tillMovement.groupBy({
      by: ['date', 'kind'],
      where: { locationId, date: { in: rows.map((r) => r.date) } },
      _sum: { amountGrosze: true },
    });
    const moved = (date: Date, kind: 'in' | 'out') =>
      movements.find((mv) => mv.date.getTime() === date.getTime() && mv.kind === kind)?._sum
        .amountGrosze ?? 0;
    const days = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      expectedCashGrosze: r.expectedCashGrosze,
      countedCashGrosze: r.countedCashGrosze,
      differenceGrosze: r.countedCashGrosze - r.expectedCashGrosze,
      cashInGrosze: moved(r.date, 'in'),
      cashOutGrosze: moved(r.date, 'out'),
    }));
    return { days, differenceGrosze: days.reduce((sum, d) => sum + d.differenceGrosze, 0) };
  }

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
