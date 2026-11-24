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
  return [review.staffName?.trim(), review.serviceName?.trim(), day].filter(Boolean).join(' · ');
}

/** Newest first, keeping page order for equal timestamps and the first copy of each review. */
export function appendSalonReviews(shown: SalonReview[], page: SalonReview[]): SalonReview[] {
  const seen = new Set(shown.map((r) => r.id));
  const result = [...shown];
  for (const review of page) {
    if (seen.has(review.id)) continue;
    result.push(review);
    seen.add(review.id);
  }
  return result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** "★★★★☆" for 4 of 5. */
export function starText(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating) || 0));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

/**
 * Task 381: the "★ 5 (12)" chips — stars with reviews (and the chosen one), five first; none
 * while there is only one kind of rating.
 */
export function starChips(
  stars: number[],
  chosen: number | null,
): { rating: number; label: string }[] {
  const shown = [5, 4, 3, 2, 1].filter((n) => (stars[n - 1] ?? 0) > 0 || n === chosen);
  if (shown.length < 2 && chosen === null) return [];
  return shown.map((n) => ({ rating: n, label: `★ ${n} (${stars[n - 1] ?? 0})` }));
}
