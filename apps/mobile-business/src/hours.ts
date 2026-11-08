import type { StaffList, WorkingHours } from './api';

/**
 * Task 95: "Grafik zespołu" — the owner or a manager changes a specialist's weekly hours in the
 * app. One text field per day ("09:00–14:00, 15:00–20:00"; empty = day off). No React Native
 * here, so it is tested in Vitest (test/hours.test.ts). The server checks everything again.
 */

export type Interval = { start: string; end: string };

/** The day's hours as the field shows them: "09:00–14:00, 15:00–20:00"; "" = day off. */
export function hoursInput(intervals: Interval[]): string {
  return intervals.map((i) => `${i.start}–${i.end}`).join(', ');
}

/** "9", "9:30", "09:30", "24" → minutes from midnight (up to 24:00); otherwise null. */
function clock(text: string): number | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * Reads one day: "9-14, 15-20", "09:00–14:00" … → sorted intervals; "" → [] (day off).
 * null when it cannot be read, an interval ends before it starts or two overlap (max 6).
 */
export function parseDayHours(text: string): Interval[] | null {
  const value = text.trim();
  if (!value) return [];
  const parts = value.split(/[,;]/).map((p) => p.trim());
  if (parts.length > 6) return null;
  const read: { start: number; end: number }[] = [];
  for (const part of parts) {
    const [a, b, ...rest] = part.split(/\s*[-–—]\s*/);
    if (a === undefined || b === undefined || rest.length > 0) return null;
    const start = clock(a);
    const end = clock(b);
    if (start === null || end === null || start >= end) return null;
    read.push({ start, end });
  }
  read.sort((x, y) => x.start - y.start);
  for (let i = 1; i < read.length; i++) {
    if (read[i]!.start < read[i - 1]!.end) return null;
  }
  return read.map((r) => ({ start: hhmm(r.start), end: hhmm(r.end) }));
}

/** The fields for Monday to Sunday, from the hours the server gave. */
export function weekInputs(hours: Pick<WorkingHours, 'weekly'>): Record<number, string> {
  const inputs: Record<number, string> = {};
  for (let weekday = 1; weekday <= 7; weekday++) {
    inputs[weekday] = hoursInput(hours.weekly.find((d) => d.weekday === weekday)?.intervals ?? []);
  }
  return inputs;
}

/** The request body (days off are left out), or the first day that cannot be read. */
export function weeklyBody(
  inputs: Record<number, string>,
):
  | { ok: true; days: { weekday: number; intervals: Interval[] }[] }
  | { ok: false; weekday: number } {
  const days: { weekday: number; intervals: Interval[] }[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    const intervals = parseDayHours(inputs[weekday] ?? '');
    if (intervals === null) return { ok: false, weekday };
    if (intervals.length > 0) days.push({ weekday, intervals });
  }
  return { ok: true, days };
}

/** Specialists still working at the salon, in the salon's order. */
export function teamForHours(staff: StaffList): StaffList {
  return staff
    .filter((s) => s.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
}

/**
 * Task 335: "Dzień specjalny" — the hours of one date replace the weekly hours that day
 * ("10:00–14:00"). The server needs at least one interval: a whole day off is "Dodaj wolne".
 */
export function specialBody(
  text: string,
): { ok: true; intervals: Interval[] } | { ok: false; problem: 'empty' | 'bad' } {
  const intervals = parseDayHours(text);
  if (intervals === null) return { ok: false, problem: 'bad' };
  if (intervals.length === 0) return { ok: false, problem: 'empty' };
  return { ok: true, intervals };
}

/** The field for a date: its special hours if it already has them, otherwise empty. */
export function specialInput(hours: Pick<WorkingHours, 'overrides'>, date: string): string {
  return hoursInput(hours.overrides.find((o) => o.date === date)?.intervals ?? []);
}

/**
 * Task 338: time off for a part of one day ("12:00–15:00" on 2026-12-24) as the API wants it,
 * location-local. Exactly one interval; null when it cannot be read.
 */
export function hoursOff(date: string, text: string): { start: string; end: string } | null {
  const intervals = parseDayHours(text);
  if (!intervals || intervals.length !== 1) return null;
  const [only] = intervals as [Interval];
  // "24:00" is the end of the day: the next day's midnight.
  const end = only.end === '24:00' ? `${nextDay(date)}T00:00` : `${date}T${only.end}`;
  return { start: `${date}T${only.start}`, end };
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
