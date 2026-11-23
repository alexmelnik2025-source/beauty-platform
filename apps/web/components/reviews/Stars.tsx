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
  invalid,
  describedBy,
}: {
  value: number;
  onChange: (rating: number) => void;
  /** Task 684: no star chosen when sending — the stars get the error's red frame. */
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className={invalid ? 'star-picker star-picker--invalid' : 'star-picker'}
      role="radiogroup"
      aria-label={t.reviews.rating}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
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
