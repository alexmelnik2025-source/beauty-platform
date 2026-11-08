import type { LoyaltyBonusRules } from './api';

/**
 * Task 346: "Dodatkowe pieczątki i punkty" in the business app (in the cabinet — BonusRulesForm,
 * task 19): ×N or +N for a paid visit at chosen specialists and/or on chosen weekdays, and if the
 * salon wants, only for clients back within N days. The server picks the best rule for a visit;
 * saved as a whole list. Tested in Vitest (test/bonusRules.test.ts).
 */

export interface BonusRow {
  name: string;
  /** Empty = every specialist. */
  staffIds: string[];
  /** ISO weekdays 1–7; empty = every day. */
  weekdays: number[];
  multiplier: string;
  extraPoints: string;
  /** '' = any visit. */
  withinDays: string;
}

export interface BonusRulesSave {
  rules: {
    name: string;
    staffIds: string[];
    weekdays: number[];
    multiplier: number;
    extraPoints: number;
    withinDays: number | null;
  }[];
}

export type BonusProblem = 'name' | 'multiplier' | 'extra' | 'nothing' | 'within' | 'tooMany';

/** At most 20 rules (the server's limit). */
export const MAX_BONUS_RULES = 20;

export const EMPTY_BONUS: BonusRow = {
  name: '',
  staffIds: [],
  weekdays: [],
  multiplier: '2',
  extraPoints: '0',
  withinDays: '',
};

export function bonusRows(data: LoyaltyBonusRules): BonusRow[] {
  return data.rules.map((r) => ({
    name: r.name,
    staffIds: r.staff.map((s) => s.id),
    weekdays: [...r.weekdays],
    multiplier: String(r.multiplier),
    extraPoints: String(r.extraPoints),
    withinDays: r.withinDays === null ? '' : String(r.withinDays),
  }));
}

/** Adds or takes away one item of a choice list. */
export function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function whole(text: string, fallback: number): number {
  const t = text.trim();
  if (t === '') return fallback;
  return /^\d{1,6}$/.test(t) ? Number(t) : NaN;
}

/** Checks the rows; returns the list for `PUT …/loyalty/bonus-rules` or what to fix (and where). */
export function bonusToSave(
  rows: BonusRow[],
): { ok: true; save: BonusRulesSave } | { ok: false; problem: BonusProblem; row?: number } {
  if (rows.length > MAX_BONUS_RULES) return { ok: false, problem: 'tooMany' };
  const rules: BonusRulesSave['rules'] = [];
  for (const [row, r] of rows.entries()) {
    const name = r.name.trim();
    if (name.length < 1 || name.length > 60) return { ok: false, problem: 'name', row };
    const multiplier = whole(r.multiplier, 1);
    if (!(multiplier >= 1 && multiplier <= 10)) return { ok: false, problem: 'multiplier', row };
    const extraPoints = whole(r.extraPoints, 0);
    if (!(extraPoints >= 0 && extraPoints <= 100_000)) return { ok: false, problem: 'extra', row };
    if (multiplier === 1 && extraPoints === 0) return { ok: false, problem: 'nothing', row };
    let withinDays: number | null = null;
    if (r.withinDays.trim() !== '') {
      withinDays = whole(r.withinDays, NaN);
      if (!(withinDays >= 1 && withinDays <= 365)) return { ok: false, problem: 'within', row };
    }
    rules.push({
      name,
      staffIds: [...new Set(r.staffIds)],
      weekdays: [...new Set(r.weekdays)].sort((a, b) => a - b),
      multiplier,
      extraPoints,
      withinDays,
    });
  }
  return { ok: true, save: { rules } };
}

/** "×2 · +1" — what the rule gives. */
export function bonusGives(rule: { multiplier: number; extraPoints: number }): string {
  return [
    rule.multiplier > 1 ? `×${rule.multiplier}` : null,
    rule.extraPoints > 0 ? `+${rule.extraPoints}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
