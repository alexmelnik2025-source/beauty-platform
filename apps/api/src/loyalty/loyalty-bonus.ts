import type { LoyaltyBonusRule } from '../generated/prisma/client';

type BonusRule = Pick<
  LoyaltyBonusRule,
  'name' | 'staffIds' | 'weekdays' | 'multiplier' | 'extraPoints' | 'withinDays'
>;

/** The visit a bonus rule is checked against. */
export interface BonusVisit {
  staffId: string;
  /** ISO weekday in the salon time zone, 1 = Monday. */
  weekday: number;
  /** Calendar days since the client's previous paid visit at the salon; null = none before. */
  daysSincePrevious: number | null;
}

/**
 * Does the rule cover this visit: its specialist (empty = all), its weekday (empty = all)
 * and, if the rule asks for it, a previous paid visit at most withinDays before.
 */
export function bonusRuleMatches(rule: BonusRule, visit: BonusVisit): boolean {
  return (
    (rule.staffIds.length === 0 || rule.staffIds.includes(visit.staffId)) &&
    (rule.weekdays.length === 0 || rule.weekdays.includes(visit.weekday)) &&
    (rule.withinDays === null ||
      (visit.daysSincePrevious !== null && visit.daysSincePrevious <= rule.withinDays))
  );
}

/**
 * Task 19: what a paid visit earns with the salon's bonus rules. Rules never add up:
 * the one that gives the client the most wins (base × multiplier + extra).
 * A visit that earns nothing by itself (below the minimum, service rule 0) stays at 0.
 */
export function withBonus(
  base: number,
  rules: readonly BonusRule[],
  visit: BonusVisit,
): { points: number; rule: BonusRule | null } {
  let best: { points: number; rule: BonusRule | null } = { points: base, rule: null };
  if (base <= 0) return best;
  for (const rule of rules) {
    if (!bonusRuleMatches(rule, visit)) continue;
    const points = base * rule.multiplier + rule.extraPoints;
    if (points > best.points) best = { points, rule };
  }
  return best;
}
