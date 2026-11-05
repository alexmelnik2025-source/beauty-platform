import type { InstantRange, LocalInterval } from '../scheduling/slots';
import { datesBetween, isoWeekday, zonedToInstant } from '../scheduling/time';

const MINUTE_MS = 60_000;

/** One specialist's working time, the same way free times are counted (task 141). */
export interface OccupancySchedule {
  /** Weekly template by ISO weekday (1–7). */
  weekly: Map<number, LocalInterval[]>;
  /** Special hours by local date; replace the weekly template for that date. */
  overrides: Map<string, LocalInterval[]>;
  /** Vacations and blocked time: not working time. */
  away: InstantRange[];
}

export interface Occupancy {
  workMinutes: number;
  bookedMinutes: number;
}

/** Sorted, non-overlapping ranges. */
function merge(ranges: InstantRange[]): InstantRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const result: InstantRange[] = [];
  for (const r of sorted) {
    const last = result[result.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else result.push({ ...r });
  }
  return result;
}

/** `ranges` minus `cut` (both merged). */
function subtract(ranges: InstantRange[], cut: InstantRange[]): InstantRange[] {
  const result: InstantRange[] = [];
  for (const r of ranges) {
    let pieces = [r];
    for (const c of cut) {
      pieces = pieces.flatMap((p) => {
        if (c.end <= p.start || c.start >= p.end) return [p];
        const out: InstantRange[] = [];
        if (c.start > p.start) out.push({ start: p.start, end: c.start });
        if (c.end < p.end) out.push({ start: c.end, end: p.end });
        return out;
      });
    }
    result.push(...pieces);
  }
  return result;
}

function overlapMs(a: InstantRange[], b: InstantRange[]): number {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) total += end - start;
    }
  }
  return total;
}

const minutes = (ms: number) => Math.round(ms / MINUTE_MS);

/**
 * Task 141: how many minutes a specialist worked by their schedule in the salon's dates
 * `from`–`to` (weekly hours or special days, minus vacations and blocked time), and how many
 * of those minutes visits took. Visits outside working hours do not count, so the share is
 * never over 100%. Overlapping visits count once.
 */
export function occupancy(
  schedule: OccupancySchedule,
  visits: InstantRange[],
  from: string,
  to: string,
  timeZone: string,
): Occupancy {
  const work: InstantRange[] = [];
  for (const date of datesBetween(from, to)) {
    const intervals = schedule.overrides.get(date) ?? schedule.weekly.get(isoWeekday(date)) ?? [];
    for (const i of intervals) {
      work.push({
        start: zonedToInstant(date, i.startMinute, timeZone),
        end: zonedToInstant(date, i.endMinute, timeZone),
      });
    }
  }
  const working = subtract(merge(work), merge(schedule.away));
  const workMs = working.reduce((sum, r) => sum + (r.end - r.start), 0);
  return {
    workMinutes: minutes(workMs),
    bookedMinutes: minutes(overlapMs(working, merge(visits))),
  };
}

/** Whole percent of working time taken by visits; 0 without working time. */
export function occupancyPercent(o: Occupancy): number {
  return o.workMinutes > 0 ? Math.round((o.bookedMinutes / o.workMinutes) * 100) : 0;
}
