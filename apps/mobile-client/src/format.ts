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

/** A salon-local YYYY-MM-DD. Reject impossible days before Date can roll them forward. */
function calendarDay(value: string): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

/** ISO instant from the API. A wall-clock time alone is ambiguous on the client's device. */
export function parseInstant(iso: string): number {
  const match =
    typeof iso === 'string' && /^(\d{4}-\d{2}-\d{2})T.+(?:Z|[+-]\d{2}:?\d{2})$/i.exec(iso);
  return match && calendarDay(match[1]!) ? Date.parse(iso) : NaN;
}

/** "wtorek, 10 listopada" for the salon-local date YYYY-MM-DD (no time zone shift). */
export function formatDay(date: string, locale: Locale): string {
  const day = calendarDay(date);
  if (!day) return '—';
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(day);
}

/** Prices come in hundredths of the salon's currency (ISO 4217, launch task L5). */
export function formatPrice(hundredths: number, currency: string, locale: Locale): string {
  if (!Number.isFinite(hundredths) || typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency))
    return '—';
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

/** A missing instant or an unknown salon time zone has no reliable display value. */
export function formatInstant(
  iso: string,
  locale: Locale,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat(LOCALE_TAGS[locale], options).format(parseInstant(iso));
  } catch (error) {
    if (error instanceof RangeError) return '—';
    throw error;
  }
}

/** "10 listopada 15:30" — a moment (ISO) shown in the salon's time zone, not the phone's. */
export function formatMoment(iso: string, timeZone: string, locale: Locale): string {
  return formatInstant(iso, locale, {
    timeZone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "10 lutego 2027" — the date of a moment (ISO) in the salon's time zone. */
export function formatDate(iso: string, timeZone: string | undefined, locale: Locale): string {
  return formatInstant(iso, locale, {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** "wt" + "10" for the day strip of "Change time" (salon-local date, no time zone shift). */
export function dayChip(date: string, locale: Locale): { weekday: string; day: string } {
  const local = calendarDay(date);
  if (!local) return { weekday: '', day: '—' };
  const weekday = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(local);
  return { weekday, day: String(local.getUTCDate()) };
}

function bookableSlots(slots: Slot[]): Slot[] {
  if (!Array.isArray(slots)) return [];
  return slots.filter((slot) => {
    return (
      slot &&
      calendarDay(slot.date) &&
      typeof slot.time === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time) &&
      Number.isFinite(parseInstant(slot.start)) &&
      Array.isArray(slot.staffIds) &&
      slot.staffIds.length > 0 &&
      slot.staffIds.every((id) => typeof id === 'string' && id.trim().length > 0)
    );
  });
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
  const currentStart = current ? parseInstant(current.start) : NaN;
  for (const slot of bookableSlots(slots)) {
    if (current && Date.parse(slot.start) === currentStart) continue;
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
  const sorted = bookableSlots(slots).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const slot of sorted) {
    if (!first.has(ANY_STAFF)) first.set(ANY_STAFF, slot);
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
  const local = calendarDay(slot.date);
  if (!local) return texts.nearestNone;
  const day = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(local);
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
    tooLate: confirmed && !visit.canChange && parseInstant(visit.end) > Date.now(),
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
    const date = formatDate(summary.firstVisitAt, timeZone, locale);
    parts.push(fill(texts.summarySince, { date }));
  }
  const spent = summary.spent.map((s) => formatPrice(s.amountGrosze, s.currency, locale));
  return {
    visits: parts.join(' · '),
    spent: spent.length ? fill(texts.summarySpent, { amount: spent.join(' + ') }) : null,
  };
}

/** Task 298: every salon of the visits once, in the order they come (the latest visit first). */
export function salonsOf(items: ClientAppointment[]): { slug: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const a of items) if (!seen.has(a.salon.slug)) seen.set(a.salon.slug, a.salon.name);
  return [...seen].map(([slug, name]) => ({ slug, name }));
}
