import type { ClientAppointment, Locale } from './api';

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

/** Prices come in grosze. */
export function formatPrice(grosze: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], { style: 'currency', currency: 'PLN' }).format(
    grosze / 100,
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

/** What the client can do with a visit on its card. */
export function visitActions(visit: ClientAppointment): {
  cancel: boolean;
  /** Still ahead and confirmed, but past the salon's deadline — call the salon instead. */
  tooLate: boolean;
} {
  const confirmed = visit.status === 'confirmed';
  return {
    cancel: confirmed && visit.canChange,
    tooLate: confirmed && !visit.canChange && Date.parse(visit.end) > Date.now(),
  };
}
