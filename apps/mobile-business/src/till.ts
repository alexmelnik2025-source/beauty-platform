import type { SalonReport } from './api';

/**
 * Task 228: "Kasa dnia" — what the paid visits of one day brought, by payment method (task
 * 227), and how many came but are not paid. Read from the salon report of that day, so the
 * server decides whose visits count (the whole salon, or a specialist's own).
 */
export interface Till {
  revenueGrosze: number;
  currency: string;
  own: boolean;
  methods: SalonReport['payments'];
  unpaid: number;
}

/** Null when the report is for another day, or nobody came yet. */
export function tillOf(report: SalonReport | null, date: string): Till | null {
  if (!report || report.from !== date || report.to !== date) return null;
  const unpaid = report.totals.completed - report.totals.paid;
  if (report.totals.paid === 0 && unpaid === 0) return null;
  return {
    revenueGrosze: report.totals.revenueGrosze,
    currency: report.location.currency,
    own: report.scope === 'own',
    methods: report.payments,
    unpaid,
  };
}
