import { addDays } from './day';

/** Periods of the "Raporty" screen (task 15), in the salon's own dates. */
export const REPORT_PERIODS = ['thisMonth', 'lastMonth', 'last30'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** The first and last day of a period; "today" is the salon's local date. */
export function reportRange(period: ReportPeriod, today: string): { from: string; to: string } {
  const monthStart = `${today.slice(0, 8)}01`;
  if (period === 'lastMonth') {
    const lastEnd = addDays(monthStart, -1);
    return { from: `${lastEnd.slice(0, 8)}01`, to: lastEnd };
  }
  if (period === 'last30') return { from: addDays(today, -29), to: today };
  return { from: monthStart, to: today };
}

/** Share of online bookings among visits that were not cancelled, in whole percent. */
export function onlineShare(totals: {
  visits: number;
  online: number;
  cancelledByClient: number;
  cancelledBySalon: number;
}): number {
  const kept = totals.visits - totals.cancelledByClient - totals.cancelledBySalon;
  return kept > 0 ? Math.round((totals.online / kept) * 100) : 0;
}

/** Task 32: "+12%" / "−5%" against the days before; null when there is nothing to compare. */
export function change(now: number, before: number): string | null {
  if (before <= 0) return null;
  const percent = Math.round(((now - before) / before) * 100);
  if (percent === 0) return null;
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`;
}

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;

/** Monday … Sunday (ISO 1–7) in the app's language; 2026-11-02 was a Monday. */
export function weekdayLong(weekday: number, locale: keyof typeof INTL_LOCALE): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', weekday: 'long' }).format(
    new Date(Date.UTC(2026, 10, 1 + weekday)),
  );
}

/** Task 213: average stars with one decimal in the app's language — "4,5" / "4.5". */
export function starsText(average: number, locale: keyof typeof INTL_LOCALE): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(average);
}

/** Task 216: the busiest hours of the week, most visits first (then earlier in the week). */
export function peakHours<T extends { weekday: number; hour: number; visits: number }>(
  cells: T[],
  count = 3,
): T[] {
  return [...cells]
    .sort((a, b) => b.visits - a.visits || a.weekday - b.weekday || a.hour - b.hour)
    .slice(0, count);
}
