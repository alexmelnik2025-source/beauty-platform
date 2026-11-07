'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, LOCALE_TAGS, useI18n } from '@/lib/i18n';
import { formatPrice } from '@/lib/time';
import type { SalonReport } from '@/lib/types';

/**
 * Task 228: "Kasa dnia" above the day's calendar — what the paid visits of the day brought, by
 * payment method (task 227), and how many came but are not paid yet. The numbers come from the
 * salon report of that one day, so the server decides who sees what: the whole salon for the
 * owner and managers, own visits for a specialist with "own earnings", nothing for others.
 */
export function TillStrip({
  base,
  date,
  currency,
  refresh,
}: {
  base: string;
  date: string;
  currency: string;
  /** Changes whenever the calendar has new data, so a payment shows at once. */
  refresh: unknown;
}) {
  const { t, locale } = useI18n();
  const tag = LOCALE_TAGS[locale];
  const [report, setReport] = useState<SalonReport | null>(null);

  useEffect(() => {
    let alive = true;
    api<SalonReport>(`${base}/reports`, { query: { from: date, to: date } })
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch(() => {
        if (alive) setReport(null);
      });
    return () => {
      alive = false;
    };
  }, [base, date, refresh]);

  if (!report || report.from !== date) return null;
  const { totals } = report;
  const unpaid = totals.completed - totals.paid;
  if (totals.paid === 0 && unpaid === 0) return null;
  const money = (hundredths: number) => formatPrice(hundredths, currency, tag);
  return (
    <div className="till-strip" role="status" aria-label={t.calendar.tillLabel} data-testid="till">
      <strong>
        {t.calendar.till}: {money(totals.revenueGrosze)}
      </strong>
      {report.scope === 'own' ? <span className="muted">{t.calendar.tillOwn}</span> : null}
      {report.payments.map((p) => (
        <span key={p.method}>
          {p.method === 'unknown'
            ? t.reports.paymentsUnknown
            : t.appointment.paymentMethods[p.method]}{' '}
          {money(p.revenueGrosze)}
        </span>
      ))}
      {unpaid > 0 ? (
        <span className="till-strip__unpaid">
          {fill(t.calendar.tillUnpaid, { n: String(unpaid) })}
        </span>
      ) : null}
    </div>
  );
}
