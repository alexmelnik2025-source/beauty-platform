'use client';

import { useI18n } from '@/lib/i18n';
import { SPECIALTIES, type Specialty } from '@/lib/types';

export type { Specialty };

/**
 * What a specialist does: toggle buttons (the order of choosing is kept, the first is the main
 * one) and a short text for anything the list does not have.
 */
export function SpecialtyPicker({
  value,
  custom,
  onChange,
  onCustomChange,
}: {
  value: Specialty[];
  custom: string;
  onChange: (next: Specialty[]) => void;
  onCustomChange: (next: string) => void;
}) {
  const { t } = useI18n();
  const title = t.specialties.title;
  return (
    <fieldset className="field lang-picker specialty-picker">
      <legend>{title}</legend>
      <div className="chips" role="group" aria-label={title}>
        {SPECIALTIES.map((code) => {
          const on = value.includes(code);
          return (
            <button
              key={code}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((c) => c !== code) : [...value, code])}
            >
              {t.specialties.names[code]}
            </button>
          );
        })}
      </div>
      <small className="muted">{t.specialties.hint}</small>
      <label className="field">
        <span>
          {t.specialties.custom} ({t.common.optional})
        </span>
        <input
          maxLength={40}
          value={custom}
          placeholder={t.specialties.customHint}
          onChange={(e) => onCustomChange(e.target.value)}
        />
      </label>
    </fieldset>
  );
}

/** "Barber, Hairdresser, Trichologist" in the page language; empty when nothing is set. */
export function useSpecialtyText(): (
  specialties: readonly Specialty[] | undefined,
  custom: string | null | undefined,
) => string {
  const { t } = useI18n();
  return (specialties, custom) =>
    [
      ...(specialties ?? []).map((code) => t.specialties.names[code]),
      ...(custom ? [custom] : []),
    ].join(', ');
}
