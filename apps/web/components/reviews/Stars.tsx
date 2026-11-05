'use client';

import { fill, useI18n } from '@/lib/i18n';

/** Read-only stars, e.g. ★★★★☆ for 4 (an average is rounded to whole stars). */
export function Stars({ value }: { value: number }) {
  const { t } = useI18n();
  const whole = Math.round(value);
  return (
    <span className="stars" role="img" aria-label={fill(t.reviews.outOf, { n: String(value) })}>
      {'★'.repeat(whole)}
      <span className="stars-off">{'★'.repeat(5 - whole)}</span>
    </span>
  );
}

/** Five tappable stars for the client's rating. */
export function StarPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (rating: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="star-picker" role="radiogroup" aria-label={t.reviews.rating}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={fill(t.reviews.outOf, { n: String(n) })}
          className={n <= value ? 'star star--on' : 'star'}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}
