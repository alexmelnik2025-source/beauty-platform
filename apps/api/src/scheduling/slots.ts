import { datesBetween, instantToLocal, isoWeekday, zonedToInstant } from './time';

const MINUTE_MS = 60_000;

/** Minutes after local midnight, end exclusive. */
export interface LocalInterval {
  startMinute: number;
  endMinute: number;
}

/** Half-open instant range [start, end). */
export interface InstantRange {
  start: number;
  end: number;
}

export interface StaffSchedule {
  staffId: string;
  /** Weekly template by ISO weekday (1–7). */
  weekly: Map<number, LocalInterval[]>;
  /** Special hours by local date; replace the weekly template for that date. */
  overrides: Map<string, LocalInterval[]>;
  /** Vacations, blocked time and (from task 4) existing appointments incl. their buffer. */
  busy: InstantRange[];
}

export interface SlotQuery {
  timeZone: string;
  /** Local dates, inclusive. */
  from: string;
  to: string;
  durationMinutes: number;
  bufferMinutes: number;
  stepMinutes: number;
  /** Slots starting before this instant are not offered (now + minimum lead time). */
  earliestStart: number;
  /** Slots starting at or after this instant are not offered (booking horizon). */
  latestStart: number;
}

export interface Slot {
  /** Instant, ISO 8601 UTC. */
  start: string;
  /** Local date and wall-clock time at the location. */
  date: string;
  time: string;
  staffIds: string[];
}

function overlaps(a: InstantRange, b: InstantRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Free start times for one staff member.
 * A slot is offered only if the service AND its buffer fit inside working hours
 * and touch no busy range. Working intervals are converted to instants first,
 * then stepped in real minutes, so daylight-saving days have no slot in the
 * skipped hour; a wall-clock time that occurs twice (autumn) is offered once.
 */
export function staffSlots(schedule: StaffSchedule, query: SlotQuery): number[] {
  const occupyMs = (query.durationMinutes + query.bufferMinutes) * MINUTE_MS;
  const stepMs = query.stepMinutes * MINUTE_MS;
  const result: number[] = [];

  for (const date of datesBetween(query.from, query.to)) {
    const intervals = schedule.overrides.get(date) ?? schedule.weekly.get(isoWeekday(date)) ?? [];
    const seenLabels = new Set<string>();

    for (const interval of [...intervals].sort((a, b) => a.startMinute - b.startMinute)) {
      const workStart = zonedToInstant(date, interval.startMinute, query.timeZone);
      const workEnd = zonedToInstant(date, interval.endMinute, query.timeZone);

      for (let start = workStart; start + occupyMs <= workEnd; start += stepMs) {
        if (start < query.earliestStart || start >= query.latestStart) continue;
        const candidate = { start, end: start + occupyMs };
        if (schedule.busy.some((busy) => overlaps(candidate, busy))) continue;

        const label = instantToLocal(start, query.timeZone).time;
        if (seenLabels.has(label)) continue; // repeated hour when clocks go back
        seenLabels.add(label);
        result.push(start);
      }
    }
  }
  return result;
}

/** Merges per-staff slots into one sorted list; each slot lists who is free. */
export function mergeSlots(
  schedules: StaffSchedule[],
  query: SlotQuery,
): Slot[] {
  const byStart = new Map<number, string[]>();
  for (const schedule of schedules) {
    for (const start of staffSlots(schedule, query)) {
      const staff = byStart.get(start) ?? [];
      staff.push(schedule.staffId);
      byStart.set(start, staff);
    }
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, staffIds]) => {
      const local = instantToLocal(start, query.timeZone);
      return { start: new Date(start).toISOString(), date: local.date, time: local.time, staffIds };
    });
}
