import type { LoyaltyBonusRule } from '../generated/prisma/client';

type BonusRule = Pick<
  LoyaltyBonusRule,
  'name' | 'staffIds' | 'weekdays' | 'multiplier' | 'extraPoints'
>;

/** Does the rule cover this visit: its specialist (empty = all) and its weekday (empty = all)? */
export function bonusRuleMatches(rule: BonusRule, staffId: string, weekday: number): boolean {
  return (
    (rule.staffIds.length === 0 || rule.staffIds.includes(staffId)) &&
    (rule.weekdays.length === 0 || rule.weekdays.includes(weekday))
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
  staffId: string,
  weekday: number,
): { points: number; rule: BonusRule | null } {
  let best: { points: number; rule: BonusRule | null } = { points: base, rule: null };
  if (base <= 0) return best;
  for (const rule of rules) {
    if (!bonusRuleMatches(rule, staffId, weekday)) continue;
    const points = base * rule.multiplier + rule.extraPoints;
    if (points > best.points) best = { points, rule };
  }
  return best;
}
