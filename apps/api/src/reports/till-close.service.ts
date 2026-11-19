import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Location, PaymentMethod } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, instantToLocal, localToday, zonedToInstant } from '../scheduling/time';
import type { TillCloseResponse } from './reports.responses';
import type { CloseTillInput, TillMovementInput, VisitsCsvQuery } from './reports.schemas';
import { tillCsv, type TillCsvLine } from './till-csv';

/** Task 239: how far back "Kasa nie została zamknięta" looks for a day with cash. */
const UNCLOSED_LOOKBACK_DAYS = 14;

/** Task 552: the ways of paying that are not cash, in the order "Zamknij kasę" lists them. */
const OTHER_METHODS = ['card', 'blik', 'transfer', 'other'] as const;

const dayNotStarted = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'DAY_NOT_STARTED',
    'The till of a day that has not started cannot be closed',
  );

/**
 * Task 232: "Zamknij kasę" — at the end of a day the owner or a manager types how much cash is
 * in the till; the app puts it beside what the visits of that day paid in cash (task 227)
 * should have brought and shows the difference. Counting again replaces the note. Only for
 * those who see the whole salon (owners and the location's managers); a specialist gets 403.
 * Tips are not part of it — the app does not know how a tip was paid.
 *
 * Task 236: cash put into the till (change for the day) or taken out of it (bought towels,
 * taken to the bank) is noted with a reason; the till should then hold the cash visits plus
 * what was put in minus what was taken out.
 */
@Injectable()
export class TillCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  async get(m: MembershipContext, locationId: string, date: string): Promise<TillCloseResponse> {
    const location = await this.access.writable(m, locationId);
    return this.view(location, date);
  }

  async close(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: CloseTillInput,
  ): Promise<TillCloseResponse> {
    const location = await this.access.writable(m, locationId);
    if (input.date > localToday(Date.now(), location.timezone)) {
      throw dayNotStarted();
    }
    const { expected } = await this.cash(location, input.date);
    const date = new Date(`${input.date}T00:00:00Z`);
    const data = {
      countedCashGrosze: input.countedCashGrosze,
      expectedCashGrosze: expected,
      note: input.note?.trim() || null,
      closedByUserId: userId,
      closedByName: await this.userName(userId),
      closedAt: new Date(),
    };
    await this.prisma.tillClose.upsert({
      where: { locationId_date: { locationId, date } },
      create: { locationId, date, ...data },
      update: data,
    });
    return this.view(location, input.date);
  }

  /** Task 236: notes cash put into ("in") or taken out of ("out") the till on a day. */
  async addMovement(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: TillMovementInput,
  ): Promise<TillCloseResponse> {
    const location = await this.access.writable(m, locationId);
    if (input.date > localToday(Date.now(), location.timezone)) {
      throw dayNotStarted();
    }
    await this.prisma.tillMovement.create({
      data: {
        locationId,
        date: new Date(`${input.date}T00:00:00Z`),
        kind: input.kind,
        amountGrosze: input.amountGrosze,
        note: input.note,
        createdByUserId: userId,
        createdByName: await this.userName(userId),
      },
    });
    return this.view(location, input.date);
  }

  /** Task 236: removes a cash movement noted by mistake; answers the till of its day. */
  async removeMovement(
    m: MembershipContext,
    locationId: string,
    movementId: string,
  ): Promise<TillCloseResponse> {
    const location = await this.access.writable(m, locationId);
    const row = await this.prisma.tillMovement.findFirst({
      where: { id: movementId, locationId },
    });
    if (!row) throw notFound('Till movement');
    await this.prisma.tillMovement.delete({ where: { id: row.id } });
    return this.view(location, row.date.toISOString().slice(0, 10));
  }

  /**
   * Task 238: the till of a period as a CSV cash journal for the accountant — every cash put in
   * or taken out and every close, oldest first. Owners and managers only, like the till itself.
   */
  async csv(
    m: MembershipContext,
    locationId: string,
    query: VisitsCsvQuery,
  ): Promise<{ csv: string; fileName: string }> {
    const location = await this.access.writable(m, locationId);
    const days = {
      gte: new Date(`${query.from}T00:00:00Z`),
      lte: new Date(`${query.to}T00:00:00Z`),
    };
    const [movements, closes] = await Promise.all([
      this.prisma.tillMovement.findMany({ where: { locationId, date: days } }),
      this.prisma.tillClose.findMany({ where: { locationId, date: days } }),
    ]);
    const tz = location.timezone;
    const lines: (TillCsvLine & { at: number })[] = [
      ...movements.map((mv) => ({
        date: mv.date.toISOString().slice(0, 10),
        time: instantToLocal(mv.createdAt.getTime(), tz).time,
        at: mv.createdAt.getTime(),
        kind: mv.kind,
        amountGrosze: mv.amountGrosze,
        expectedGrosze: null,
        note: mv.note,
        by: mv.createdByName,
      })),
      ...closes.map((c) => ({
        date: c.date.toISOString().slice(0, 10),
        time: instantToLocal(c.closedAt.getTime(), tz).time,
        at: c.closedAt.getTime(),
        kind: 'close' as const,
        amountGrosze: c.countedCashGrosze,
        expectedGrosze: c.expectedCashGrosze,
        note: c.note,
        by: c.closedByName,
      })),
    ];
    // By till day; within a day in the order noted, the close of the day last.
    lines.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Number(a.kind === 'close') - Number(b.kind === 'close') ||
        a.at - b.at,
    );
    return {
      csv: tillCsv(lines, query.locale),
      fileName: `till-${location.slug}-${query.from}-${query.to}.csv`,
    };
  }

  private async userName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user?.name ?? '';
  }

  private async view(location: Location, date: string): Promise<TillCloseResponse> {
    const [cash, row, unclosedDay] = await Promise.all([
      this.cash(location, date),
      this.prisma.tillClose.findUnique({
        where: {
          locationId_date: { locationId: location.id, date: new Date(`${date}T00:00:00Z`) },
        },
      }),
      this.unclosedDay(location, date),
    ]);
    return {
      date,
      currency: location.currency,
      expectedCashGrosze: cash.expected,
      visitsCashGrosze: cash.visits,
      visitsVoucherGrosze: cash.visitsVouchers,
      vouchersCashGrosze: cash.vouchers,
      otherPayments: await this.otherPayments(location, date),
      cashInGrosze: cash.cashIn,
      cashOutGrosze: cash.cashOut,
      movements: cash.movements.map((mv) => ({
        id: mv.id,
        kind: mv.kind,
        amountGrosze: mv.amountGrosze,
        note: mv.note,
        createdByName: mv.createdByName,
        createdAt: mv.createdAt.toISOString(),
      })),
      close: row
        ? {
            countedCashGrosze: row.countedCashGrosze,
            expectedCashGrosze: row.expectedCashGrosze,
            differenceGrosze: row.countedCashGrosze - row.expectedCashGrosze,
            note: row.note,
            closedByName: row.closedByName,
            closedAt: row.closedAt.toISOString(),
          }
        : null,
      unclosedDay,
    };
  }

  /**
   * Task 239: "Kasa nie została zamknięta" — the latest day before `date` (up to 14 days back)
   * on which the till had cash: visits that took place and were paid in cash, or cash put in or
   * taken out. That day when its till was not counted; null when it was, or there was none.
   */
  private async unclosedDay(location: Location, date: string): Promise<string | null> {
    const from = addDays(date, -UNCLOSED_LOOKBACK_DAYS);
    const [visit, movement, voucher] = await Promise.all([
      this.prisma.appointment.findFirst({
        where: {
          locationId: location.id,
          status: 'completed',
          paidAt: { not: null },
          paymentMethod: 'cash',
          startAt: {
            gte: new Date(zonedToInstant(from, 0, location.timezone)),
            lt: new Date(zonedToInstant(date, 0, location.timezone)),
          },
        },
        orderBy: { startAt: 'desc' },
        select: { startAt: true },
      }),
      this.prisma.tillMovement.findFirst({
        where: {
          locationId: location.id,
          date: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${date}T00:00:00Z`) },
        },
        orderBy: { date: 'desc' },
        select: { date: true },
      }),
      this.prisma.giftVoucher.findFirst({
        where: {
          locationId: location.id,
          paymentMethod: 'cash',
          cancelledAt: null,
          createdAt: {
            gte: new Date(zonedToInstant(from, 0, location.timezone)),
            lt: new Date(zonedToInstant(date, 0, location.timezone)),
          },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    const days = [
      visit ? instantToLocal(visit.startAt.getTime(), location.timezone).date : '',
      movement ? movement.date.toISOString().slice(0, 10) : '',
      voucher ? instantToLocal(voucher.createdAt.getTime(), location.timezone).date : '',
    ];
    const latest = days.sort().at(-1);
    if (!latest) return null;
    const closed = await this.prisma.tillClose.findUnique({
      where: {
        locationId_date: { locationId: location.id, date: new Date(`${latest}T00:00:00Z`) },
      },
      select: { id: true },
    });
    return closed ? null : latest;
  }

  /**
   * What should be in the till: the visits of the day that took place and were paid in cash
   * (price minus discounts), plus cash put in, minus cash taken out (task 236).
   */
  private async cash(location: Location, date: string) {
    const [{ cash: visits, vouchers: visitsVouchers }, vouchers, movements] = await Promise.all([
      this.visitsCash(location, date),
      this.vouchersCash(location, date),
      this.prisma.tillMovement.findMany({
        where: { locationId: location.id, date: new Date(`${date}T00:00:00Z`) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const sum = (kind: 'in' | 'out') =>
      movements.filter((mv) => mv.kind === kind).reduce((s, mv) => s + mv.amountGrosze, 0);
    const cashIn = sum('in');
    const cashOut = sum('out');
    return {
      visits,
      visitsVouchers,
      vouchers,
      cashIn,
      cashOut,
      expected: visits + vouchers + cashIn - cashOut,
      movements,
    };
  }

  /**
   * What the visits of the day that took place and were paid in cash brought (price minus
   * discounts), and — task 546 — the part of them paid with gift vouchers ("Zapłać bonem" in the
   * visit card, not undone), which is not cash in the till: the salon took that money when it
   * sold the voucher.
   */
  private async visitsCash(
    location: Location,
    date: string,
  ): Promise<{ cash: number; vouchers: number }> {
    const rows = await this.prisma.appointment.findMany({
      where: {
        locationId: location.id,
        status: 'completed',
        paidAt: { not: null },
        paymentMethod: 'cash',
        startAt: {
          gte: new Date(zonedToInstant(date, 0, location.timezone)),
          lt: new Date(zonedToInstant(addDays(date, 1), 0, location.timezone)),
        },
      },
      select: {
        priceGrosze: true,
        discountGrosze: true,
        voucherUses: { where: { undoneAt: null }, select: { amountGrosze: true } },
      },
    });
    let cash = 0;
    let vouchers = 0;
    for (const a of rows) {
      const price = Math.max(0, a.priceGrosze - a.discountGrosze);
      const byVoucher = Math.min(
        price,
        a.voucherUses.reduce((sum, u) => sum + u.amountGrosze, 0),
      );
      cash += price - byVoucher;
      vouchers += byVoucher;
    }
    return { cash, vouchers };
  }

  /**
   * Task 552: what the day brought not in cash — the visits that took place and were paid by card,
   * BLIK, transfer or another way (price minus discounts minus what was paid with gift vouchers,
   * like the cash visits) and the gift vouchers sold that day paid that way (not cancelled). Only
   * ways with something in them, in a fixed order — what the owner checks with the card terminal
   * and the bank at the end of the day.
   */
  private async otherPayments(
    location: Location,
    date: string,
  ): Promise<TillCloseResponse['otherPayments']> {
    const methods: PaymentMethod[] = [...OTHER_METHODS];
    const from = new Date(zonedToInstant(date, 0, location.timezone));
    const to = new Date(zonedToInstant(addDays(date, 1), 0, location.timezone));
    const [visits, vouchers] = await Promise.all([
      this.prisma.appointment.findMany({
        where: {
          locationId: location.id,
          status: 'completed',
          paidAt: { not: null },
          paymentMethod: { in: methods },
          startAt: { gte: from, lt: to },
        },
        select: {
          paymentMethod: true,
          priceGrosze: true,
          discountGrosze: true,
          voucherUses: { where: { undoneAt: null }, select: { amountGrosze: true } },
        },
      }),
      this.prisma.giftVoucher.groupBy({
        by: ['paymentMethod'],
        where: {
          locationId: location.id,
          paymentMethod: { in: methods },
          cancelledAt: null,
          createdAt: { gte: from, lt: to },
        },
        _count: { _all: true },
        _sum: { amountGrosze: true },
      }),
    ]);
    return OTHER_METHODS.map((method) => {
      const own = visits.filter((a) => a.paymentMethod === method);
      const visitsGrosze = own.reduce((sum, a) => {
        const price = Math.max(0, a.priceGrosze - a.discountGrosze);
        const byVoucher = a.voucherUses.reduce((s, u) => s + u.amountGrosze, 0);
        return sum + Math.max(0, price - byVoucher);
      }, 0);
      const sold = vouchers.find((v) => v.paymentMethod === method);
      const vouchersGrosze = sold?._sum.amountGrosze ?? 0;
      return {
        method,
        visits: own.length,
        visitsGrosze,
        vouchers: sold?._count._all ?? 0,
        vouchersGrosze,
        totalGrosze: visitsGrosze + vouchersGrosze,
      };
    }).filter((row) => row.visits > 0 || row.vouchers > 0);
  }

  /**
   * Task 547: what gift vouchers sold that day (salon time) for cash brought — not cancelled ones
   * (a cancelled voucher's money was given back).
   */
  private async vouchersCash(location: Location, date: string): Promise<number> {
    const sum = await this.prisma.giftVoucher.aggregate({
      where: {
        locationId: location.id,
        paymentMethod: 'cash',
        cancelledAt: null,
        createdAt: {
          gte: new Date(zonedToInstant(date, 0, location.timezone)),
          lt: new Date(zonedToInstant(addDays(date, 1), 0, location.timezone)),
        },
      },
      _sum: { amountGrosze: true },
    });
    return sum._sum.amountGrosze ?? 0;
  }
}
