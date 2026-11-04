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
