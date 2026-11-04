import type { ClientAppointment, Locale, Slot } from './api';

/** Dates and prices as the client reads them. No React Native here — tested in Vitest. */

export const LOCALE_TAGS: Record<Locale, string> = {
  pl: 'pl-PL',
  uk: 'uk-UA',
  ru: 'ru-RU',
  en: 'en-GB',
};

/** "wtorek, 10 listopada" for the salon-local date YYYY-MM-DD (no time zone shift). */
export function formatDay(date: string, locale: Locale): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Prices come in hundredths of the salon's currency (ISO 4217, launch task L5). */
export function formatPrice(hundredths: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], { style: 'currency', currency }).format(
    hundredths / 100,
  );
}

/** "ul. Marszałkowska 1, Warszawa" — the parts the salon filled in. */
export function salonAddress(salon: ClientAppointment['salon']): string {
  return [salon.addressLine, salon.city].filter((part) => part.trim()).join(', ');
}

/**
 * Visits grouped by day, in the order the API sent them (upcoming: soonest first,
 * history: newest first), so the list reads like a calendar.
 */
export function groupByDay(
  items: ClientAppointment[],
): { date: string; items: ClientAppointment[] }[] {
  const groups: { date: string; items: ClientAppointment[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }
  return groups;
}

/** "10 listopada 15:30" — a moment (ISO) shown in the salon's time zone, not the phone's. */
export function formatMoment(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "wt" + "10" for the day strip of "Change time" (salon-local date, no time zone shift). */
export function dayChip(date: string, locale: Locale): { weekday: string; day: string } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return { weekday, day: String(d) };
}

/**
 * Free times grouped by the salon's local day, in order; the visit's own time is left out
 * (moving to the same time changes nothing).
 */
export function slotsByDay(
  slots: Slot[],
  current?: { start: string },
): { date: string; slots: Slot[] }[] {
  const days: { date: string; slots: Slot[] }[] = [];
  for (const slot of slots) {
    if (current && Date.parse(slot.start) === Date.parse(current.start)) continue;
    const last = days.at(-1);
    if (last && last.date === slot.date) last.slots.push(slot);
    else days.push({ date: slot.date, slots: [slot] });
  }
  return days;
}

/** What the client can do with a visit on its card. */
export function visitActions(visit: ClientAppointment): {
  cancel: boolean;
  /** Change the time (same rules as cancelling: confirmed and before the salon's deadline). */
  move: boolean;
  /** Still ahead and confirmed, but past the salon's deadline — call the salon instead. */
  tooLate: boolean;
} {
  const confirmed = visit.status === 'confirmed';
  return {
    cancel: confirmed && visit.canChange,
    move: confirmed && visit.canChange,
    tooLate: confirmed && !visit.canChange && Date.parse(visit.end) > Date.now(),
  };
}
