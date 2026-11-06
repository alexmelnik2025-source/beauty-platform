'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import type { PublicReviews } from '@/lib/types';
import { SalonReply } from './SalonReply';
import { Stars } from './Stars';

/**
 * Task 165b: reviews on the salon page — the average, the averages of the specialists and the
 * newest reviews (no client data). Nothing while the salon does not collect reviews or has none.
 */
export function SalonReviews({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [page, setPage] = useState<PublicReviews | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [items, setItems] = useState<PublicReviews['items']>([]);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    api<PublicReviews>(`/v1/public/locations/${slug}/reviews`, {
      auth: false,
      query: staffId ? { staffId } : {},
    })
      .then((res) => {
        if (!staffId) setPage(res);
        setItems(res.items);
        setNext(res.nextBefore);
      })
      .catch(() => setPage(null));
  }, [slug, staffId]);

  if (!page?.enabled || page.count === 0 || page.average === null) return null;

  async function more() {
    if (!next) return;
    const res = await api<PublicReviews>(`/v1/public/locations/${slug}/reviews`, {
      auth: false,
      query: { before: next, ...(staffId ? { staffId } : {}) },
    });
    setItems((prev) => [...prev, ...res.items]);
    setNext(res.nextBefore);
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
            <button type="button" aria-pressed={staffId === null} onClick={() => setStaffId(null)}>
              {t.reviews.everyone}
            </button>
            {page.staff.map((s) => (
              <button
                key={s.staffId}
                type="button"
                aria-pressed={staffId === s.staffId}
                onClick={() => setStaffId(s.staffId)}
              >
                {s.displayName} ★ {s.average === null ? '' : one.format(s.average)} ({s.count})
              </button>
            ))}
          </div>
        ) : null}
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
          <button type="button" className="btn btn--quiet" onClick={() => void more()}>
            {t.reviews.more}
          </button>
        ) : null}
      </div>
    </details>
  );
}
