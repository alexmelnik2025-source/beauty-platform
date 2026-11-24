'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorText, fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { PublicReviews } from '@/lib/types';
import { SalonReply } from './SalonReply';
import { StarFilter } from './StarFilter';
import { FieldError } from '../ui';
import { Stars } from './Stars';

/**
 * Task 165b: reviews on the salon page — the average, the averages of the specialists and the
 * newest reviews (no client data). Nothing while the salon does not collect reviews or has none.
 * Task 380: "★ 5 (12)" chips — only the reviews with that many stars.
 */
export function SalonReviews({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [page, setPage] = useState<PublicReviews | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [stars, setStars] = useState<number[]>([]);
  const [items, setItems] = useState<PublicReviews['items']>([]);
  const [next, setNext] = useState<string | null>(null);
  /**
   * Task 803: "Pokaż więcej" — one request at a time (a second tap does not add the same reviews
   * twice), and a refused one is said under the button (owner's rule: errors where the action
   * is) instead of nothing happening.
   */
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');

  useEffect(() => {
    // Task 803: a slow answer for the filter chosen before does not replace the newer one.
    let current = true;
    setMoreError('');
    api<PublicReviews>(`/v1/public/locations/${slug}/reviews`, {
      auth: false,
      query: { ...(staffId ? { staffId } : {}), ...(rating ? { rating: String(rating) } : {}) },
    })
      .then((res) => {
        if (!current) return;
        if (!staffId && !rating) setPage(res);
        setStars(res.stars);
        setItems(res.items);
        setNext(res.nextBefore);
      })
      .catch(() => {
        if (current) setPage(null);
      });
    return () => {
      current = false;
    };
  }, [slug, staffId, rating]);

  if (!page?.enabled || page.count === 0 || page.average === null) return null;

  async function more() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const res = await api<PublicReviews>(`/v1/public/locations/${slug}/reviews`, {
        auth: false,
        query: {
          before: next,
          ...(staffId ? { staffId } : {}),
          ...(rating ? { rating: String(rating) } : {}),
        },
      });
      setItems((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...res.items.filter((r) => !seen.has(r.id))];
      });
      setNext(res.nextBefore);
    } catch (err) {
      setMoreError(errorText(t, err));
    } finally {
      setLoadingMore(false);
    }
  }

  const one = new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const date = (iso: string) =>
    new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric' }).format(
      new Date(iso),
    );

  return (
    <details className="salon-reviews small">
      <summary>
        <Stars value={page.average} />{' '}
        <span>
          {fill(t.reviews.summary, { avg: one.format(page.average), count: String(page.count) })}
        </span>
      </summary>
      <div className="stack">
        {page.staff.length > 1 ? (
          <div className="chips" role="group" aria-label={t.reviews.bySpecialist}>
            <button
              type="button"
              aria-pressed={staffId === null}
              onClick={() => {
                setStaffId(null);
                setRating(null);
              }}
            >
              {t.reviews.everyone}
            </button>
            {page.staff.map((s) => (
              <button
                key={s.staffId}
                type="button"
                aria-pressed={staffId === s.staffId}
                onClick={() => {
                  setStaffId(s.staffId);
                  setRating(null);
                }}
              >
                {s.displayName} ★ {s.average === null ? '' : one.format(s.average)} ({s.count})
              </button>
            ))}
          </div>
        ) : null}
        <StarFilter stars={stars} value={rating} onChange={setRating} />
        <ul className="review-list">
          {items.map((r) => (
            <li key={r.id}>
              <div className="review-head">
                <Stars value={r.rating} />
                <span className="muted">
                  {r.staffName} · {r.serviceName} · {date(r.createdAt)}
                </span>
              </div>
              {r.text ? <p className="review-text">{r.text}</p> : null}
              <SalonReply text={r.reply} />
            </li>
          ))}
        </ul>
        {next ? (
          <div>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={loadingMore}
              aria-describedby={moreError ? 'salon-reviews-more-error' : undefined}
              onClick={() => void more()}
            >
              {t.reviews.more}
            </button>
            <FieldError id="salon-reviews-more-error" text={moreError} />
          </div>
        ) : null}
      </div>
    </details>
  );
}
