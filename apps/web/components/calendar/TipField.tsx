'use client';

import { useEffect, useId, useState } from 'react';
import { useI18n } from '@/lib/i18n';

/** 1500 → "15", 1550 → "15,50" — for the field. */
function tipInput(hundredths: number): string {
  if (hundredths === 0) return '';
  const whole = Math.floor(hundredths / 100);
  const cents = hundredths % 100;
  return cents === 0 ? String(whole) : `${whole},${String(cents).padStart(2, '0')}`;
}

/** "15", "15,5", "15.50", "" → hundredths (empty = 0); null when it is not an amount. */
export function parseTip(text: string): number | null {
  const compact = text.replace(/\s/g, '').replace(',', '.');
  if (compact === '') return 0;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(compact)) return null;
  const value = Math.round(Number(compact) * 100);
  return value <= 10_000_000 ? value : null;
}

/**
 * Task 229: the tip the client left on a visit that took place — only a note for the report
 * and "Kasa dnia"; not part of the price. An empty field clears it.
 */
export function TipField({
  value,
  currency,
  onSave,
  disabled,
}: {
  value: number;
  currency: string;
  onSave: (tipGrosze: number) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(tipInput(value));
  useEffect(() => setText(tipInput(value)), [value]);
  const parsed = parseTip(text);
  return (
    <form
      className="stack"
      style={{ gap: 6 }}
      data-testid="tip-field"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed !== null && parsed !== value) onSave(parsed);
      }}
    >
      <label className="small muted" htmlFor={id}>
        {t.appointment.tip} ({currency})
      </label>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={text}
          aria-invalid={parsed === null}
          onChange={(e) => setText(e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <button
          type="submit"
          className="btn btn--quiet btn--small"
          disabled={disabled || parsed === null || parsed === value}
        >
          {t.appointment.tipSave}
        </button>
      </div>
      <span className="small muted">
        {parsed === null ? t.appointment.tipInvalid : t.appointment.tipHint}
      </span>
    </form>
  );
}
