'use client';

import { useId } from 'react';
import { useI18n } from '@/lib/i18n';
import { PAYMENT_METHODS, type PaymentMethod } from '@/lib/types';

/**
 * Task 227: how the client paid — Gotówka / Karta / BLIK / Przelew / Inna. Only a mark for the
 * report and the till; a tap on the chosen one takes it off again (not said).
 */
export function PaymentMethodPicker({
  value,
  onChange,
  disabled,
}: {
  value: PaymentMethod | null;
  onChange: (method: PaymentMethod | null) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const labelId = useId();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="small muted" id={labelId}>
        {t.appointment.paymentMethod}
      </span>
      <span
        className="seg seg--wide"
        role="group"
        aria-labelledby={labelId}
        data-testid="payment-method"
      >
        {PAYMENT_METHODS.map((method) => (
          <button
            key={method}
            type="button"
            aria-pressed={value === method}
            disabled={disabled}
            onClick={() => onChange(value === method ? null : method)}
          >
            {t.appointment.paymentMethods[method]}
          </button>
        ))}
      </span>
    </div>
  );
}
