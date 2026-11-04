/**
 * Time-zone arithmetic on Node's built-in Intl (no date library).
 *
 * Conventions:
 * - A "local date" is 'YYYY-MM-DD' in the location's time zone.
 * - A "local minute" is minutes after local midnight (0–1440).
 * - Instants are milliseconds since the epoch (UTC).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(instant: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
  };
}

/** UTC offset in minutes at an instant (Warsaw: +60 in winter, +120 in summer). */
export function offsetMinutes(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const flooredInstant = Math.floor(instant / MINUTE_MS) * MINUTE_MS;
  return Math.round((asUtc - flooredInstant) / MINUTE_MS);
}

export function isValidLocalDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function parseDate(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m || !isValidLocalDate(date)) throw new Error(`Invalid date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, m, d] = parseDate(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar days from one local date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = parseDate(from);
  const [y2, m2, d2] = parseDate(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/** Inclusive list of dates from `from` to `to`. */
export function datesBetween(from: string, to: string): string[] {
  const result: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    result.push(date);
  }
  return result;
}

/**
 * The instant of a local wall-clock time. Same rules as Temporal's "compatible"
 * disambiguation, which people expect:
 * - time that occurs twice (autumn, clocks go back) → the earlier occurrence;
 * - time that does not exist (spring, clocks go forward) → moved forward by the gap
 *   (02:30 on the spring-forward day in Warsaw becomes 03:30).
 */
export function zonedToInstant(date: string, localMinute: number, timeZone: string): number {
  const [y, m, d] = parseDate(date);
  const wall = Date.UTC(y, m - 1, d) + localMinute * MINUTE_MS;
  // Offsets a day before and after cover any transition near this time.
  const before = offsetMinutes(wall - DAY_MS, timeZone);
  const after = offsetMinutes(wall + DAY_MS, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset * MINUTE_MS)
    .filter((instant) => wall - offsetMinutes(instant, timeZone) * MINUTE_MS === instant)
    .sort((a, b) => a - b);
  if (candidates.length > 0) {
    return candidates[0]!;
  }
  // Gap: interpret with the offset before the transition, which lands after the gap.
  return wall - before * MINUTE_MS;
}

/** Local date and wall-clock time of an instant. */
export function instantToLocal(
  instant: number,
  timeZone: string,
): { date: string; minute: number; time: string } {
  const p = localParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    minute: p.hour * 60 + p.minute,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** Today's local date in a time zone. */
export function localToday(now: number, timeZone: string): string {
  return instantToLocal(now, timeZone).date;
}

/** 'HH:mm' (00:00–24:00) → minutes after midnight; null if invalid. */
export function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes <= 1440 ? minutes : null;
}

export function formatClock(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** 'YYYY-MM-DDTHH:mm' in the location's time zone → instant; null if malformed. */
export function parseLocalDateTime(value: string, timeZone: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!m || !isValidLocalDate(m[1]!)) return null;
  const minute = parseClock(m[2]!);
  if (minute === null) return null;
  return zonedToInstant(m[1]!, minute, timeZone);
}
