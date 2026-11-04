'use client';

import { useId, useState } from 'react';
import { LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { DIAL_CODES, dialLabel, dialOf, withDial } from '@/lib/phone';

/**
 * A phone number with the country code chosen from a list (launch task L5). The text stays one
 * value ("+90 532 100 2000"); choosing a country replaces the code at its start. The salon's own
 * country comes first. Normalize with normalizePhone(value, dialForTimeZone(salon time zone)).
 */
export function PhoneField({
  label,
  value,
  onChange,
  defaultDial,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The salon's country code ("48"): listed first and chosen when the number has none. */
  defaultDial: string;
  required?: boolean;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const tag = LOCALE_TAGS[locale];
  // Kazakhstan and Russia share +7, so the chosen country is remembered, not guessed back.
  const [region, setRegion] = useState(() => {
    const dial = dialOf(value) ?? defaultDial;
    return DIAL_CODES.find((c) => c.dial === dial)?.region ?? 'PL';
  });
  const typed = dialOf(value);
  const shown =
    typed === null || DIAL_CODES.some((c) => c.region === region && c.dial === typed)
      ? region
      : (DIAL_CODES.find((c) => c.dial === typed)?.region ?? region);
  const own = DIAL_CODES.filter((c) => c.dial === defaultDial);
  const options = [...own, ...DIAL_CODES.filter((c) => c.dial !== defaultDial)];

  return (
    <div className="field">
      <span>
        <label htmlFor={id}>{label}</label>
      </span>
      <div className="phone-field">
        <select
          aria-label={t.phone.country}
          value={shown}
          onChange={(e) => {
            const next = DIAL_CODES.find((c) => c.region === e.target.value);
            if (!next) return;
            setRegion(next.region);
            onChange(withDial(value, next.dial));
          }}
        >
          {options.map((c) => (
            <option key={c.region} value={c.region}>
              {dialLabel(c.region, c.dial, tag)}
            </option>
          ))}
        </select>
        <input
          id={id}
          type="tel"
          autoComplete="tel"
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
