import type { ReviewSettings, SalonReviews } from './api';
import type { DayLocale } from './day';
import { fill, type Dictionary } from './i18n';

/**
 * "Opinie" in the business app (task 201; reviews themselves — task 165b): what clients wrote
 * after their visits, with the client's name. Everyone in the team opens it; a specialist without
 * "all appointments" gets only reviews of their own visits from the server. No React Native here
 * — tested in Vitest (test/reviews.test.ts).
 */

export type Review = SalonReviews['items'][number];

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;

/** An older page is added below; a review already shown is not repeated. */
export function appendReviews(shown: Review[], page: Review[]): Review[] {
  const seen = new Set(shown.map((r) => r.id));
  return [...shown, ...page.filter((r) => !seen.has(r.id))];
}

/** "★★★★☆" for 4 of 5. */
export function stars(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

/** "★ 4,7 · opinie: 3", or "Brak opinii." without any. */
export function reviewSummary(
  data: Pick<SalonReviews, 'count' | 'average'>,
  t: Dictionary,
  locale: DayLocale,
): string {
  if (data.count === 0 || data.average === null) return t.reviews.none;
  const average = new Intl.NumberFormat(INTL_LOCALE[locale], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(data.average);
  return fill(t.reviews.summary, { average, count: String(data.count) });
}

/**
 * "Anna Nowak · Strzyżenie u Kasia · 5 lis 2026" — who, what, with whom and the visit's day in the
 * salon's time zone. A client who was anonymised is "Klient usunięty".
 */
export function reviewLine(
  review: Review,
  t: Dictionary,
  locale: DayLocale,
  timeZone: string,
): string {
  const day = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(review.visitStartAt));
  return [
    review.customerName ?? t.reviews.removedClient,
    fill(t.reviews.service, { service: review.serviceName, staff: review.staffName }),
    day,
  ].join(' · ');
}

/** Task 341: when the client is asked, hours after the visit ends (as in the cabinet). */
export const REVIEW_HOURS = [1, 2, 3, 6, 12, 24, 48, 72] as const;

/** The choices, with a value saved elsewhere (any 1–72) kept in its place. */
export function reviewHoursChoices(current: number): number[] {
  const list: number[] = [...REVIEW_HOURS];
  if (!list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

/** Whether "Zapisz" would change anything. */
export function reviewSettingsChanged(saved: ReviewSettings, form: ReviewSettings): boolean {
  return saved.enabled !== form.enabled || saved.requestHours !== form.requestHours;
}
