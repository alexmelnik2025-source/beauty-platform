import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Location } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, localToday, zonedToInstant } from '../scheduling/time';
import type { TillCloseResponse } from './reports.responses';
import type { CloseTillInput } from './reports.schemas';

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
    const expected = await this.expectedCash(location, input.date);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const date = new Date(`${input.date}T00:00:00Z`);
    const data = {
      countedCashGrosze: input.countedCashGrosze,
      expectedCashGrosze: expected,
      note: input.note?.trim() || null,
      closedByUserId: userId,
      closedByName: user?.name ?? '',
      closedAt: new Date(),
    };
    await this.prisma.tillClose.upsert({
      where: { locationId_date: { locationId, date } },
      create: { locationId, date, ...data },
      update: data,
    });
    return this.view(location, input.date);
  }

  private async view(location: Location, date: string): Promise<TillCloseResponse> {
    const [expected, row] = await Promise.all([
      this.expectedCash(location, date),
      this.prisma.tillClose.findUnique({
        where: {
          locationId_date: { locationId: location.id, date: new Date(`${date}T00:00:00Z`) },
        },
      }),
    ]);
    return {
      date,
      currency: location.currency,
      expectedCashGrosze: expected,
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
    };
  }

  /** What the visits of the day that took place and were paid in cash brought (price minus discounts). */
  private async expectedCash(location: Location, date: string): Promise<number> {
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
      select: { priceGrosze: true, discountGrosze: true },
    });
    return rows.reduce((sum, a) => sum + a.priceGrosze - a.discountGrosze, 0);
  }
}
