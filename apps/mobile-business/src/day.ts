import type { AppointmentDetail, Calendar, StaffList, TimeOff, WorkingHours } from './api';

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
  staffId: string;
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
      staffId: a.staff.id,
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

/**
 * The salon's specialist who is the signed-in person (an owner or manager who also
 * cuts hair), or null. Used for the "only mine" switch.
 */
export function myStaffId(staff: StaffList, userId: string): string | null {
  return staff.find((s) => s.userId === userId)?.id ?? null;
}

export function onlyMine(visits: DayVisit[], staffId: string | null): DayVisit[] {
  return staffId ? visits.filter((v) => v.staffId === staffId) : visits;
}

/**
 * Which buttons the visit card shows — the same rules as the web calendar:
 * "came / did not come" once a confirmed visit has started, "paid" after it took place.
 * The server checks everything again.
 */
export function visitActions(
  visit: Pick<AppointmentDetail, 'status' | 'start' | 'paidAt'>,
  canChange: boolean,
  now = Date.now(),
): { came: boolean; noShow: boolean; pay: boolean; unpay: boolean } {
  const started = Date.parse(visit.start) <= now;
  const live = canChange && visit.status === 'confirmed' && started;
  const done = canChange && visit.status === 'completed';
  return { came: live, noShow: live, pay: done && !visit.paidAt, unpay: done && !!visit.paidAt };
}

/** "45,00 zł", "€45.00" — prices come in hundredths of the salon's currency (launch task L5). */
export function formatPrice(hundredths: number, currency: string, locale: DayLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], { style: 'currency', currency }).format(
    hundredths / 100,
  );
}

/** "poniedziałek" … "niedziela" for ISO weekdays 1–7. */
export function weekdayName(weekday: number, locale: DayLocale): string {
  // 2026-11-02 is a Monday.
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', weekday: 'long' }).format(
    new Date(Date.UTC(2026, 10, 1 + weekday, 12)),
  );
}

/** Monday to Sunday with their hours, e.g. "09:00–14:00, 15:00–20:00"; null = day off. */
export function weekRows(
  hours: WorkingHours,
  locale: DayLocale,
): { weekday: number; name: string; hours: string | null }[] {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const intervals = hours.weekly.find((d) => d.weekday === weekday)?.intervals ?? [];
    return {
      weekday,
      name: weekdayName(weekday, locale),
      hours: intervals.length ? intervals.map((i) => `${i.start}–${i.end}`).join(', ') : null,
    };
  });
}

function shortDate(date: string, locale: DayLocale): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/**
 * Time off in words: whole days "śr., 24 gru – pt., 26 gru" (the end is exclusive
 * midnight, so the last day shown is the day before), hours "śr., 24 gru 10:00–14:00".
 */
export function timeOffText(off: Pick<TimeOff, 'start' | 'end'>, locale: DayLocale): string {
  const [startDate, startTime] = off.start.split('T') as [string, string];
  const [endDate, endTime] = off.end.split('T') as [string, string];
  if (startTime === '00:00' && endTime === '00:00') {
    const last = addDays(endDate, -1);
    return last === startDate
      ? shortDate(startDate, locale)
      : `${shortDate(startDate, locale)} – ${shortDate(last, locale)}`;
  }
  if (startDate === endDate) return `${shortDate(startDate, locale)} ${startTime}–${endTime}`;
  return `${shortDate(startDate, locale)} ${startTime} – ${shortDate(endDate, locale)} ${endTime}`;
}

/** Whole days off from `from` to `to` (both included) as the API wants them. */
export function daysOff(from: string, to: string): { start: string; end: string } | null {
  if (to < from) return null;
  return { start: `${from}T00:00`, end: `${addDays(to, 1)}T00:00` };
}
