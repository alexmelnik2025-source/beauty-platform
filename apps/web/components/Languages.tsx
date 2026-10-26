'use client';

import { useI18n } from '@/lib/i18n';
import { SPOKEN, type Spoken } from '@/lib/types';

export type { Spoken };

/** Short labels as clients know them: flags of the countries, not ISO language codes. */
const SHORT: Record<Spoken, string> = { pl: 'PL', uk: 'UA', ru: 'RU', be: 'BY', en: 'EN' };

/** Toggle buttons for the spoken languages; keeps the order in which they were chosen. */
export function LanguagePicker({
  value,
  onChange,
  title,
  hint,
}: {
  value: Spoken[];
  onChange: (next: Spoken[]) => void;
  title: string;
  hint?: string;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="field lang-picker">
      <legend>{title}</legend>
      <div className="chips" role="group" aria-label={title}>
        {SPOKEN.map((code) => {
          const on = value.includes(code);
          return (
            <button
              key={code}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((c) => c !== code) : [...value, code])}
            >
              <b>{SHORT[code]}</b> {t.languages.names[code]}
            </button>
          );
        })}
      </div>
      {hint ? <small className="muted">{hint}</small> : null}
    </fieldset>
  );
}

/** Small "PL · UA · RU" badges for the booking page; the full names are read by screen readers. */
export function LanguageBadges({ codes, label }: { codes: Spoken[]; label?: string }) {
  const { t } = useI18n();
  if (codes.length === 0) return null;
  const names = codes.map((c) => t.languages.names[c]).join(', ');
  return (
    <span
      className="lang-badges"
      role="note"
      aria-label={`${label ?? t.languages.speaks}: ${names}`}
    >
      {label ? (
        <span className="small muted" aria-hidden="true">
          {label}
        </span>
      ) : null}
      {codes.map((c) => (
        <span key={c} className="chip" title={t.languages.names[c]} aria-hidden="true">
          {SHORT[c]}
        </span>
      ))}
    </span>
  );
}
