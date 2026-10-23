/**
 * Time-zone arithmetic with the built-in Intl API (the same rules as the API's
 * scheduling/time.ts). Local date = 'YYYY-MM-DD' in the salon's time zone.
 */
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

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

function parts(instant: number, timeZone: string) {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute! };
}

function offsetMinutes(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  return Math.round((asUtc - Math.floor(instant / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toLocal(instant: number | string, timeZone: string) {
  const ms = typeof instant === 'string' ? Date.parse(instant) : instant;
  const p = parts(ms, timeZone);
  return {
    date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`,
    minute: p.h * 60 + p.mi,
    time: `${pad(p.h)}:${pad(p.mi)}`,
  };
}

export function todayIn(timeZone: string): string {
  return toLocal(Date.now(), timeZone).date;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant of a local wall-clock time (earlier one when it occurs twice). */
export function zonedToInstant(date: string, minute: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + minute * MINUTE_MS;
  const before = offsetMinutes(wall - DAY_MS, timeZone);
  const after = offsetMinutes(wall + DAY_MS, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset * MINUTE_MS)
    .filter((instant) => wall - offsetMinutes(instant, timeZone) * MINUTE_MS === instant)
    .sort((a, b) => a - b);
  return candidates[0] ?? wall - before * MINUTE_MS;
}

export function clockToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function minutesToClock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "piątek, 23 października" in the reader's language. */
export function formatDay(date: string, localeTag: string, opts?: { short?: boolean }): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(localeTag, {
    timeZone: 'UTC',
    weekday: opts?.short ? 'short' : 'long',
    day: 'numeric',
    month: opts?.short ? 'short' : 'long',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function weekdayShort(date: string, localeTag: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(localeTag, { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function formatPrice(grosze: number, localeTag: string): string {
  return new Intl.NumberFormat(localeTag, { style: 'currency', currency: 'PLN' }).format(
    grosze / 100,
  );
}
