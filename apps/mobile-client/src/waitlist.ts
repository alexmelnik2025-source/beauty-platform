import { addDays } from './api';

/**
 * Task 51: the days the waiting list is offered for — the days of the booking window that have
 * no free time for this service (and specialist). Days with free times are booked instead.
 */
export function waitlistDays(today: string, freeDates: Iterable<string>, count: number): string[] {
  const free = new Set(freeDates);
  return Array.from({ length: count }, (_, i) => addDays(today, i)).filter((d) => !free.has(d));
}
