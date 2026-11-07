import type { Calendar } from './api';
import { addDays, staffOfDay, timeIn } from './day';

/** Task 214: the Monday of the week that holds `date` (ISO weeks, Monday first). */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(date, 1 - weekday);
}

export type WeekDay = {
  date: string;
  /** Visits that are not cancelled (also the ones waiting for the salon's answer). */
  visits: number;
  /** Visits waiting for the salon to accept them ("Ochrona przed odwołaniami"). */
  waiting: number;
  /** From the first visit's start to the last visit's end, "09:00–18:30"; null without visits. */
  span: string | null;
  /** How many specialists work that day by the schedule. */
  working: number;
};

/** Monday to Sunday of the week starting `from`: how full each day is. */
export function weekSummary(calendar: Calendar, from: string): WeekDay[] {
  const tz = calendar.location.timezone;
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const date = addDays(from, i);
    const visits = calendar.appointments
      .filter((a) => a.date === date && !['held', 'expired', 'cancelled'].includes(a.status))
      .sort((a, b) => a.start.localeCompare(b.start));
    const last = visits.reduce<string | null>(
      (max, a) => (max === null || a.end > max ? a.end : max),
      null,
    );
    return {
      date,
      visits: visits.length,
      waiting: visits.filter((a) => a.awaitingApproval === true).length,
      span: visits.length > 0 && last ? `${visits[0]!.time}–${timeIn(last, tz)}` : null,
      working: staffOfDay(calendar, date).length,
    };
  });
}
