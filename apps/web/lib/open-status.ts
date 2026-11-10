/**
 * Task 362: "Otwarte · do 20:00" / "Zamknięte · otwarcie o 10:00" on the salon page. Today's
 * hours come from the API (special days, vacations and salon-wide blocks included); the next
 * days — from the weekly table. The same logic lives in apps/mobile-client/src/salon.ts.
 */

interface Interval {
  start: string;
  end: string;
}

export type OpenStatus =
  | { kind: 'open'; until: string }
  | { kind: 'opensToday'; at: string }
  | { kind: 'opensLater'; inDays: number; weekday: number; at: string }
  | { kind: 'closed' };

const minutes = (clock: string) => {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * @param today today's real hours, or null when they are not known for `date` (then the weekly
 *   hours of its weekday count)
 * @param date the salon's local date now, `weekday` its ISO weekday, `minute` minutes after midnight
 */
export function openStatus(
  today: { date: string; intervals: Interval[] } | null,
  weekly: { weekday: number; intervals: Interval[] }[],
  now: { date: string; weekday: number; minute: number },
): OpenStatus {
  const weekdayHours = (weekday: number) =>
    weekly.find((d) => d.weekday === weekday)?.intervals ?? [];
  const hours = [
    ...(today && today.date === now.date ? today.intervals : weekdayHours(now.weekday)),
  ].sort((a, b) => minutes(a.start) - minutes(b.start));
  const current = hours.find((i) => minutes(i.start) <= now.minute && now.minute < minutes(i.end));
  if (current) {
    // Hours that continue without a break (one specialist until 14:00, the next from 14:00).
    let until = current.end;
    for (const i of hours) {
      if (minutes(i.start) <= minutes(until) && minutes(i.end) > minutes(until)) until = i.end;
    }
    return { kind: 'open', until };
  }
  const later = hours.find((i) => minutes(i.start) > now.minute);
  if (later) return { kind: 'opensToday', at: later.start };
  for (let inDays = 1; inDays <= 7; inDays++) {
    const weekday = ((now.weekday - 1 + inDays) % 7) + 1;
    const first = [...weekdayHours(weekday)].sort((a, b) => minutes(a.start) - minutes(b.start))[0];
    if (first) return { kind: 'opensLater', inDays, weekday, at: first.start };
  }
  return { kind: 'closed' };
}
