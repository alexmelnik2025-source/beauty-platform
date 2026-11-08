import type { LoyaltyTiers } from './api';

/**
 * Task 345: "Poziomy klientów" in the business app (in the cabinet — TiersForm, task 10e): the
 * salon's own tiers — a name, from how many paid visits or how much paid over the last N days,
 * and the tier's discount. Saved as a whole list. Tested in Vitest (test/tiers.test.ts).
 */

export interface TierRow {
  name: string;
  /** Visits, or an amount in the salon's currency ("500" or "499,99"), as typed. */
  threshold: string;
  discountPercent: string;
}

export type TiersSave = Omit<LoyaltyTiers, 'tiers'> & {
  tiers: { name: string; threshold: number; discountPercent: number }[];
};

export type TiersProblem = 'period' | 'name' | 'threshold' | 'discount' | 'same' | 'tooMany';

/** At most 8 tiers (the server's limit). */
export const MAX_TIERS = 8;

const amount = (grosze: number) =>
  grosze % 100 === 0 ? String(grosze / 100) : (grosze / 100).toFixed(2).replace('.', ',');

export function tierRows(data: LoyaltyTiers): TierRow[] {
  return data.tiers.map((t) => ({
    name: t.name,
    threshold: data.basis === 'spend' ? amount(t.threshold) : String(t.threshold),
    discountPercent: String(t.discountPercent),
  }));
}

/** Checks the rows; returns the list for `PUT …/loyalty/tiers` or what to fix (and in which row). */
export function tiersToSave(
  basis: LoyaltyTiers['basis'],
  periodDays: string,
  rows: TierRow[],
): { ok: true; save: TiersSave } | { ok: false; problem: TiersProblem; row?: number } {
  const period = /^\d+$/.test(periodDays.trim()) ? Number(periodDays.trim()) : NaN;
  if (!(period >= 30 && period <= 1095)) return { ok: false, problem: 'period' };
  if (rows.length > MAX_TIERS) return { ok: false, problem: 'tooMany' };
  const tiers: TiersSave['tiers'] = [];
  for (const [row, r] of rows.entries()) {
    const name = r.name.trim();
    if (name.length < 1 || name.length > 40) return { ok: false, problem: 'name', row };
    const raw = r.threshold.replace(/\s/g, '').replace(',', '.');
    let threshold: number;
    if (basis === 'spend') {
      if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) return { ok: false, problem: 'threshold', row };
      threshold = Math.round(Number(raw) * 100);
    } else {
      if (!/^\d{1,6}$/.test(raw)) return { ok: false, problem: 'threshold', row };
      threshold = Number(raw);
    }
    const d = r.discountPercent.trim() === '' ? '0' : r.discountPercent.trim();
    if (!/^\d{1,3}$/.test(d) || Number(d) > 100) return { ok: false, problem: 'discount', row };
    if (tiers.some((t) => t.threshold === threshold)) return { ok: false, problem: 'same', row };
    tiers.push({ name, threshold, discountPercent: Number(d) });
  }
  return { ok: true, save: { basis, periodDays: period, tiers } };
}
