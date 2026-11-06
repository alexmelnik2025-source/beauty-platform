import type { Locale, PublicReviews } from './api';
import { LOCALE_TAGS } from './format';
import { fill, type Dictionary } from './i18n';

/**
 * Task 212: "Opinie" on the salon page of the client app — the same reviews as on the salon's
 * booking page (task 165b) with the salon's answers (task 211). No client data comes from the
 * server. No React Native here — tested in Vitest (test/salonReviews.test.ts).
 */

export type SalonReview = PublicReviews['items'][number];

/** "4,7" — one decimal in the client's language. */
export function oneDecimal(value: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/** "★ 4,7 · opinie: 3"; null when there is nothing to show. */
export function salonReviewSummary(
  data: Pick<PublicReviews, 'enabled' | 'count' | 'average'>,
  t: Dictionary,
  locale: Locale,
): string | null {
  if (!data.enabled || data.count === 0 || data.average === null) return null;
  return fill(t.salonReviews.summary, {
    average: oneDecimal(data.average, locale),
    count: String(data.count),
  });
}

/** "Kasia ★ 4,5 (2)" — a specialist's chip. */
export function staffChip(staff: PublicReviews['staff'][number], locale: Locale): string {
  const avg = staff.average === null ? '' : ` ★ ${oneDecimal(staff.average, locale)}`;
  return `${staff.displayName}${avg} (${staff.count})`;
}

/** "Kasia · Strzyżenie · 5 lis 2026" — with whom, what and when the review was written. */
export function salonReviewLine(review: SalonReview, locale: Locale): string {
  const day = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(review.createdAt));
  return [review.staffName, review.serviceName, day].join(' · ');
}

/** An older page is added below; a review already shown is not repeated. */
export function appendSalonReviews(shown: SalonReview[], page: SalonReview[]): SalonReview[] {
  const seen = new Set(shown.map((r) => r.id));
  return [...shown, ...page.filter((r) => !seen.has(r.id))];
}

/** "★★★★☆" for 4 of 5. */
export function starText(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}
