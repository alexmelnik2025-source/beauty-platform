'use client';

import { useI18n } from '@/lib/i18n';

/**
 * Task 380: "★ 5 (12) · ★ 4 (3) …" — the reviews by stars, a tap shows only those. Stars without
 * reviews are left out (unless chosen); nothing while there is only one kind of rating.
 */
export function StarFilter({
  stars,
  value,
  onChange,
}: {
  /** How many reviews have 1…5 stars (index 0 = one star). */
  stars: number[];
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  const { t } = useI18n();
  const shown = [5, 4, 3, 2, 1].filter((n) => (stars[n - 1] ?? 0) > 0 || n === value);
  if (shown.length < 2 && value === null) return null;
  return (
    <div className="chips" role="group" aria-label={t.reviews.byStars}>
      <button type="button" aria-pressed={value === null} onClick={() => onChange(null)}>
        {t.reviews.allStars}
      </button>
      {shown.map((n) => (
        <button key={n} type="button" aria-pressed={value === n} onClick={() => onChange(n)}>
          ★ {n} ({stars[n - 1] ?? 0})
        </button>
      ))}
    </div>
  );
}
