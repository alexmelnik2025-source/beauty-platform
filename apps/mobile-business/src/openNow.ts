import { weekdayName, type DayLocale } from './day';
import { fill } from './i18n';

/**
 * Task 366: "Klienci widzą teraz: Otwarte · do 20:00" on the business app's day screen — the
 * same line clients see on the salon page and in the catalogue (task 362). Today's real hours
 * come from the public salon page (special days, vacations and salon-wide blocks included); the
 * next days — from its weekly table. Same logic as apps/mobile-client/src/salon.ts.
 */

interface Interval {
  start: string;
  end: string;
}

/** What the public salon page gives: its time zone, weekly hours and today's real hours. */
export interface PublicHours {
  timezone: string;
  openingHours: { weekday: number; intervals: Interval[] }[];
  todayHours: { date: string; intervals: Interval[] };
}

export type OpenStatus =
  | { kind: 'open'; until: string }
  | { kind: 'opensToday'; at: string }
  | { kind: 'opensLater'; inDays: number; weekday: number; at: string }
  | { kind: 'closed' };

const clockMinutes = (clock: string) => {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Local date, ISO weekday and minutes after midnight of an instant in a time zone. */
export function salonNow(
  instant: number,
  timeZone: string,
): { date: string; weekday: number; minute: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant))) {
    p[part.type] = part.value;
  }
  const date = `${p.year}-${p.month}-${p.day}`;
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return { date, weekday, minute: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

export function openStatus(
  salon: Pick<PublicHours, 'openingHours' | 'todayHours'>,
  now: { date: string; weekday: number; minute: number },
): OpenStatus {
  const weekdayHours = (weekday: number) =>
    salon.openingHours.find((d) => d.weekday === weekday)?.intervals ?? [];
  const sorted = (list: Interval[]) =>
    [...list].sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start));
  const hours = sorted(
    salon.todayHours.date === now.date ? salon.todayHours.intervals : weekdayHours(now.weekday),
  );
  const current = hours.find(
    (i) => clockMinutes(i.start) <= now.minute && now.minute < clockMinutes(i.end),
  );
  if (current) {
    // Hours that continue without a break (one specialist until 14:00, the next from 14:00).
    let until = current.end;
    for (const i of hours) {
      if (clockMinutes(i.start) <= clockMinutes(until) && clockMinutes(i.end) > clockMinutes(until))
        until = i.end;
    }
    return { kind: 'open', until };
  }
  const later = hours.find((i) => clockMinutes(i.start) > now.minute);
  if (later) return { kind: 'opensToday', at: later.start };
  for (let inDays = 1; inDays <= 7; inDays++) {
    const weekday = ((now.weekday - 1 + inDays) % 7) + 1;
    const first = sorted(weekdayHours(weekday))[0];
    if (first) return { kind: 'opensLater', inDays, weekday, at: first.start };
  }
  return { kind: 'closed' };
}

/** The status in the app's language, as clients read it. */
export function openStatusText(
  status: OpenStatus,
  t: {
    openUntil: string;
    openUntilMidnight: string;
    opensToday: string;
    opensLater: string;
    tomorrow: string;
    closedNow: string;
  },
  locale: DayLocale,
): string {
  switch (status.kind) {
    case 'open':
      return status.until === '24:00'
        ? t.openUntilMidnight
        : fill(t.openUntil, { time: status.until });
    case 'opensToday':
      return fill(t.opensToday, { time: status.at });
    case 'opensLater':
      return fill(t.opensLater, {
        day: status.inDays === 1 ? t.tomorrow : weekdayName(status.weekday, locale),
        time: status.at,
      });
    case 'closed':
      return t.closedNow;
  }
}

/** Today's hours as one line: "09:00–14:00, 15:00–20:00"; empty when closed all day. */
export function todayHoursText(salon: PublicHours, instant: number): string {
  const now = salonNow(instant, salon.timezone);
  const list =
    salon.todayHours.date === now.date
      ? salon.todayHours.intervals
      : (salon.openingHours.find((d) => d.weekday === now.weekday)?.intervals ?? []);
  return [...list]
    .sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start))
    .map((i) => `${i.start}–${i.end}`)
    .join(', ');
}
