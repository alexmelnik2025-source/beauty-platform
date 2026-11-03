import type { Calendar } from './api';

/** Dates of the day calendar: always the salon's local date, YYYY-MM-DD. */

/** Today in the salon's time zone (not the phone's). */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;
export type DayLocale = keyof typeof INTL_LOCALE;

/** "wtorek, 3 listopada" — the heading of the day. */
export function dayTitle(date: string, locale: DayLocale): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** HH:MM of a moment in the salon's time zone. */
export function timeIn(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('hour')}:${part('minute')}`;
}

export type DayVisit = {
  id: string;
  start: string;
  end: string;
  status: Calendar['appointments'][number]['status'];
  service: string;
  staff: string;
  customer: string | null;
  phone: string | null;
};

/**
 * The visits of one day, in time order. Held slots (a client is still confirming),
 * expired holds and cancelled visits are not shown — the list is what will happen.
 */
export function visitsOfDay(calendar: Calendar, date: string): DayVisit[] {
  const tz = calendar.location.timezone;
  return calendar.appointments
    .filter((a) => a.date === date && !['held', 'expired', 'cancelled'].includes(a.status))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((a) => ({
      id: a.id,
      start: a.time,
      end: timeIn(a.end, tz),
      status: a.status,
      service: a.service.name,
      staff: a.staff.displayName,
      customer: a.customer?.name ?? null,
      phone: a.customer?.phone ?? null,
    }));
}

/** Who works that day and when, e.g. "Kasia 08:00–21:00". Days off are left out. */
export function staffOfDay(calendar: Calendar, date: string): { name: string; hours: string }[] {
  return calendar.staff.flatMap((s) => {
    const intervals = s.days.find((d) => d.date === date)?.intervals ?? [];
    if (intervals.length === 0) return [];
    return [{ name: s.displayName, hours: intervals.map((i) => `${i.start}–${i.end}`).join(', ') }];
  });
}
