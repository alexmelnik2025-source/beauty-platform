import type { ClientAppointment, ClientVisitSummary, Locale, Slot } from './api';
import { fill } from './i18n';

/** Dates and prices as the client reads them. No React Native here — tested in Vitest. */

export const LOCALE_TAGS: Record<Locale, string> = {
  pl: 'pl-PL',
  uk: 'uk-UA',
  ru: 'ru-RU',
  en: 'en-GB',
  tr: 'tr-TR',
  sq: 'sq-AL',
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

/**
 * Task 62: a service's price on the price list — "od 80 zł" when its specialists' prices
 * differ, else the one price. `fromText` is the "od {price}" text of the language.
 */
export function servicePriceText(
  service: { priceFromGrosze: number; priceToGrosze: number },
  currency: string,
  locale: Locale,
  fromText: string,
): string {
  const from = formatPrice(service.priceFromGrosze, currency, locale);
  return service.priceFromGrosze < service.priceToGrosze ? fromText.replace('{price}', from) : from;
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

/** "10 lutego 2027" — the date of a moment (ISO) in the salon's time zone. */
export function formatDate(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
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

/** Key of "any specialist" in `nearestByStaff`. */
export const ANY_STAFF = '';

/**
 * Task 12: the first free time of each specialist (and of anyone, under ANY_STAFF) from the
 * free times of a service for every specialist (each slot lists who is free).
 */
export function nearestByStaff(slots: Slot[]): Map<string, Slot> {
  const first = new Map<string, Slot>();
  const sorted = [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const slot of sorted) {
    if (slot.staffIds.length > 0 && !first.has(ANY_STAFF)) first.set(ANY_STAFF, slot);
    for (const id of slot.staffIds) if (!first.has(id)) first.set(id, slot);
  }
  return first;
}

/**
 * "Dziś wolne od 14:30" / "Jutro wolne od 09:00" / "Najbliższy wolny termin: pt., 6 lis, 12:00";
 * `today` and `tomorrow` are the salon's local dates.
 */
export function nearestText(
  slot: Slot | undefined,
  days: { today: string; tomorrow: string },
  texts: { nearestToday: string; nearestTomorrow: string; nearestOn: string; nearestNone: string },
  locale: Locale,
): string {
  if (!slot) return texts.nearestNone;
  if (slot.date === days.today) return fill(texts.nearestToday, { time: slot.time });
  if (slot.date === days.tomorrow) return fill(texts.nearestTomorrow, { time: slot.time });
  const [y, m, d] = slot.date.split('-').map(Number) as [number, number, number];
  const day = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return fill(texts.nearestOn, { day, time: slot.time });
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

/** Task 180b: "1,2" — kilometres from the client, one decimal, as the language writes numbers. */
export function formatKm(km: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], {
    minimumFractionDigits: km < 10 ? 1 : 0,
    maximumFractionDigits: km < 10 ? 1 : 0,
  }).format(km);
}

/**
 * Task 180b: the stars on a salon's card — "★ 4,5 · opinie: 2"; null without reviews.
 * `text` is the language's "★ {rating} · …: {n}".
 */
export function ratingText(
  salon: { rating: number | null; reviewCount: number },
  text: string,
  locale: Locale,
): string | null {
  if (salon.rating === null || salon.reviewCount === 0) return null;
  const rating = new Intl.NumberFormat(LOCALE_TAGS[locale], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(salon.rating);
  return fill(text, { rating, n: String(salon.reviewCount) });
}

/**
 * Task 293: "Twoje wizyty" — "Odbyte wizyty: 3 · w salonach: 2 · od 9 lutego 2027" and
 * "Zapłacono łącznie: 180,00 zł" (several currencies joined with "+"; null when nothing paid).
 * The first visit's date is read in the phone's time zone.
 */
export function visitSummaryLines(
  summary: ClientVisitSummary,
  texts: {
    summaryVisits: string;
    summarySalons: string;
    summarySince: string;
    summarySpent: string;
  },
  locale: Locale,
  timeZone?: string,
): { visits: string; spent: string | null } {
  const parts = [fill(texts.summaryVisits, { n: String(summary.completed) })];
  if (summary.salons > 1) parts.push(fill(texts.summarySalons, { n: String(summary.salons) }));
  if (summary.firstVisitAt) {
    const date = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      ...(timeZone ? { timeZone } : {}),
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(summary.firstVisitAt));
    parts.push(fill(texts.summarySince, { date }));
  }
  const spent = summary.spent.map((s) => formatPrice(s.amountGrosze, s.currency, locale));
  return {
    visits: parts.join(' · '),
    spent: spent.length ? fill(texts.summarySpent, { amount: spent.join(' + ') }) : null,
  };
}
