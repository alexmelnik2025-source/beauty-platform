import { addDays, formatClock, instantToLocal, isoWeekday, zonedToInstant } from './time';

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
