import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { HappyHour, Prisma } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { HappyHoursResponse } from './happy-hours.responses';
import type { ReplaceHappyHoursInput } from './happy-hours.schemas';
import { formatClock, instantToLocal, isoWeekday, parseClock } from './time';

type Rule = Pick<
  HappyHour,
  'weekdays' | 'startMinute' | 'endMinute' | 'discountPercent' | 'staffIds' | 'serviceIds'
>;

/**
 * The happy-hour discount for a visit (task 16): the largest one among the salon's rules that
 * cover its weekday and start time (in the salon's time zone), its staff member and service.
 * null when no rule covers it.
 */
export function happyHourPercent(
  rules: Rule[],
  visit: { staffId: string; serviceId: string; weekday: number; minute: number },
): number | null {
  let best: number | null = null;
  for (const r of rules) {
    if (!r.weekdays.includes(visit.weekday)) continue;
    if (visit.minute < r.startMinute || visit.minute >= r.endMinute) continue;
    if (r.staffIds.length > 0 && !r.staffIds.includes(visit.staffId)) continue;
    if (r.serviceIds.length > 0 && !r.serviceIds.includes(visit.serviceId)) continue;
    if (best === null || r.discountPercent > best) best = r.discountPercent;
  }
  return best;
}

/** What a new visit stores about its price: the happy-hour price, rounded down to whole hundredths off. */
export interface VisitPrice {
  priceGrosze: number;
  listPriceGrosze: number | null;
  happyHourPercent: number | null;
}

export function visitPrice(listPriceGrosze: number, percent: number | null): VisitPrice {
  if (percent === null || listPriceGrosze <= 0) {
    return { priceGrosze: listPriceGrosze, listPriceGrosze: null, happyHourPercent: null };
  }
  const off = Math.floor((listPriceGrosze * percent) / 100);
  return { priceGrosze: listPriceGrosze - off, listPriceGrosze, happyHourPercent: percent };
}

const invalid = (path: string, message: string): AppException =>
  new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Invalid happy hours', [
    { path, message },
  ]);

/**
 * The salon's happy hours: owners and managers set them for a location; the price of every new
 * visit (online, by the staff, walk-ins) is counted from them on the server.
 */
@Injectable()
export class HappyHoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  async list(m: MembershipContext, locationId: string): Promise<HappyHoursResponse> {
    await this.access.readable(m, locationId);
    return this.response(locationId);
  }

  /** Replaces the whole list at once (an empty list turns happy hours off). */
  async replace(
    m: MembershipContext,
    locationId: string,
    input: ReplaceHappyHoursInput,
  ): Promise<HappyHoursResponse> {
    await this.access.writable(m, locationId);
    const [staff, services] = await Promise.all([
      this.prisma.staffMember.findMany({ where: { locationId }, select: { id: true } }),
      this.prisma.service.findMany({ where: { locationId }, select: { id: true } }),
    ]);
    const staffIds = new Set(staff.map((s) => s.id));
    const serviceIds = new Set(services.map((s) => s.id));
    const rows = input.rules.map((r, i) => {
      const startMinute = parseClock(r.start)!;
      const endMinute = parseClock(r.end)!;
      if (startMinute >= endMinute) throw invalid(`rules.${i}.end`, 'end must be after start');
      // Another location's staff member or service never gets this location's price.
      if (r.staffIds.some((id) => !staffIds.has(id))) {
        throw invalid(`rules.${i}.staffIds`, 'unknown staff member at this location');
      }
      if (r.serviceIds.some((id) => !serviceIds.has(id))) {
        throw invalid(`rules.${i}.serviceIds`, 'unknown service at this location');
      }
      return {
        locationId,
        weekdays: [...new Set(r.weekdays)].sort(),
        startMinute,
        endMinute,
        discountPercent: r.discountPercent,
        staffIds: [...new Set(r.staffIds)],
        serviceIds: [...new Set(r.serviceIds)],
        sortOrder: i * 10,
      };
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.happyHour.deleteMany({ where: { locationId } });
      if (rows.length) await tx.happyHour.createMany({ data: rows });
    });
    return this.response(locationId);
  }

  /** The price of a new visit at this location, by its staff member, service and start. */
  async priceFor(
    db: Prisma.TransactionClient,
    location: { id: string; timezone: string },
    visit: { staffId: string; serviceId: string; start: number; listPriceGrosze: number },
  ): Promise<VisitPrice> {
    const rules = await db.happyHour.findMany({ where: { locationId: location.id } });
    if (rules.length === 0) return visitPrice(visit.listPriceGrosze, null);
    const local = instantToLocal(visit.start, location.timezone);
    const percent = happyHourPercent(rules, {
      staffId: visit.staffId,
      serviceId: visit.serviceId,
      weekday: isoWeekday(local.date),
      minute: local.minute,
    });
    return visitPrice(visit.listPriceGrosze, percent);
  }

  private async response(locationId: string): Promise<HappyHoursResponse> {
    const rules = await this.prisma.happyHour.findMany({
      where: { locationId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return {
      rules: rules.map((r) => ({
        id: r.id,
        weekdays: r.weekdays,
        start: formatClock(r.startMinute),
        end: formatClock(r.endMinute),
        discountPercent: r.discountPercent,
        staffIds: r.staffIds,
        serviceIds: r.serviceIds,
      })),
    };
  }
}
