import type { PrismaService } from '../prisma/prisma.service';
import {
  addDays,
  formatClock,
  instantToLocal,
  isoWeekday,
  localToday,
  zonedToInstant,
} from './time';

/** Minutes after local midnight, end exclusive. */
interface Minutes {
  startMinute: number;
  endMinute: number;
}

/** One specialist's hours for a date: special hours replace the weekly ones. */
export interface StaffDay {
  weekly: (Minutes & { weekday: number })[];
  /** Special hours ("Dzień specjalny") of this very date, if any. */
  overrides: Minutes[];
  /** Vacations and days off of this specialist (instants, ms). */
  off: { start: number; end: number }[];
}

function merge(intervals: Minutes[]): Minutes[] {
  const sorted = intervals
    .filter((i) => i.endMinute > i.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute);
  const merged: Minutes[] = [];
  for (const i of sorted) {
    const last = merged.at(-1);
    if (last && i.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, i.endMinute);
    } else {
      merged.push({ ...i });
    }
  }
  return merged;
}

function subtract(intervals: Minutes[], cut: Minutes): Minutes[] {
  return intervals.flatMap((i) => {
    if (cut.endMinute <= i.startMinute || cut.startMinute >= i.endMinute) return [i];
    const parts: Minutes[] = [];
    if (cut.startMinute > i.startMinute)
      parts.push({ startMinute: i.startMinute, endMinute: cut.startMinute });
    if (cut.endMinute < i.endMinute)
      parts.push({ startMinute: cut.endMinute, endMinute: i.endMinute });
    return parts;
  });
}

/**
 * Task 362: the salon's real hours on one local date, as clients see them — the union of the
 * hours of everyone who takes online bookings, with special days ("Dzień specjalny") instead of
 * the weekly hours, minus vacations and days off of each specialist and the salon-wide blocks
 * ("Salon zamknięty"). An empty list means the salon is closed that day.
 */
export function hoursOn(
  date: string,
  timeZone: string,
  staff: StaffDay[],
  salonOff: { start: number; end: number }[],
): { start: string; end: string }[] {
  const dayStart = zonedToInstant(date, 0, timeZone);
  const dayEnd = zonedToInstant(addDays(date, 1), 0, timeZone);
  const toMinutes = (range: { start: number; end: number }): Minutes | null => {
    if (range.end <= dayStart || range.start >= dayEnd) return null;
    return {
      startMinute: range.start <= dayStart ? 0 : instantToLocal(range.start, timeZone).minute,
      endMinute: range.end >= dayEnd ? 1440 : instantToLocal(range.end, timeZone).minute,
    };
  };
  const weekday = isoWeekday(date);
  const all = staff.flatMap((s) => {
    let day = merge(
      s.overrides.length > 0 ? s.overrides : s.weekly.filter((w) => w.weekday === weekday),
    );
    for (const range of [...s.off, ...salonOff]) {
      const cut = toMinutes(range);
      if (cut) day = subtract(day, cut);
    }
    return day;
  });
  return merge(all).map((i) => ({
    start: formatClock(i.startMinute),
    end: formatClock(i.endMinute),
  }));
}

export interface TodayHours {
  /** Today at the salon, YYYY-MM-DD. */
  date: string;
  intervals: { start: string; end: string }[];
}

/**
 * Tasks 362–363: today's real hours of several salons at once (the salon page, the catalogue),
 * in three queries. `staff` — the specialists who take online bookings, with their weekly hours.
 */
export async function todayHoursOf(
  prisma: PrismaService,
  locations: {
    id: string;
    timezone: string;
    staff: {
      id: string;
      workingHours: { weekday: number; startMinute: number; endMinute: number }[];
    }[];
  }[],
  now = Date.now(),
): Promise<Map<string, TodayHours>> {
  const days = locations.map((l) => {
    const date = localToday(now, l.timezone);
    return {
      location: l,
      date,
      from: zonedToInstant(date, 0, l.timezone),
      to: zonedToInstant(addDays(date, 1), 0, l.timezone),
    };
  });
  const result = new Map<string, TodayHours>();
  if (days.length === 0) return result;
  const staffIds = locations.flatMap((l) => l.staff.map((s) => s.id));
  const from = new Date(Math.min(...days.map((d) => d.from)));
  const to = new Date(Math.max(...days.map((d) => d.to)));
  const dates = [...new Set(days.map((d) => d.date))].map((d) => new Date(`${d}T00:00:00.000Z`));
  const [overrides, timeOff, blocks] = await Promise.all([
    prisma.workingHoursOverride.findMany({
      where: { staffId: { in: staffIds }, date: { in: dates } },
      select: { staffId: true, date: true, startMinute: true, endMinute: true },
    }),
    prisma.timeOff.findMany({
      where: { staffId: { in: staffIds }, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { staffId: true, startsAt: true, endsAt: true },
    }),
    prisma.timeBlock.findMany({
      where: {
        locationId: { in: locations.map((l) => l.id) },
        staffId: null,
        deletedAt: null,
        startAt: { lt: to },
        endAt: { gt: from },
      },
      select: { locationId: true, startAt: true, endAt: true },
    }),
  ]);
  const range = (start: Date, end: Date) => ({ start: start.getTime(), end: end.getTime() });
  for (const { location, date } of days) {
    const intervals = hoursOn(
      date,
      location.timezone,
      location.staff.map((s) => ({
        weekly: s.workingHours,
        overrides: overrides.filter(
          (o) => o.staffId === s.id && o.date.toISOString().slice(0, 10) === date,
        ),
        off: timeOff.filter((t) => t.staffId === s.id).map((t) => range(t.startsAt, t.endsAt)),
      })),
      blocks.filter((b) => b.locationId === location.id).map((b) => range(b.startAt, b.endAt)),
    );
    result.set(location.id, { date, intervals });
  }
  return result;
}
