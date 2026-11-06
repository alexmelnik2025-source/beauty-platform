import type {
  LoyaltyProgram,
  LoyaltyProgramSave,
  LoyaltyReward,
  LoyaltyTransaction,
  NewLoyaltyReward,
} from './api';
import { formatPrice, type DayLocale } from './day';
import { fill, type Dictionary } from './i18n';

/**
 * "Program lojalnościowy" in the business app (task 206; in the cabinet — task 10b): the owner or
 * a manager switches the program on or off, sees and changes the rewards and the latest
 * operations. The detailed rules (points per amount, expiry, tiers, bonus rules) stay in the
 * cabinet. No React Native here — tested in Vitest (test/loyalty.test.ts).
 */

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;

/** Owners and managers only (the API says the same: staff never create stamps or points). */
export function mayManageLoyalty(role: 'owner' | 'manager' | 'staff'): boolean {
  return role !== 'staff';
}

/** The settings as they are, only switched on or off (the server wants all of them back). */
export function programToSave(program: LoyaltyProgram, enabled: boolean): LoyaltyProgramSave {
  return {
    version: program.version,
    enabled,
    mode: program.mode,
    stampsPerVisit: program.stampsPerVisit,
    pointsPerUnit: program.pointsPerUnit,
    spendUnitGrosze: program.spendUnitGrosze,
    minSpendGrosze: program.minSpendGrosze,
    pointsValidityDays: program.pointsValidityDays,
    maxDiscountPercent: program.maxDiscountPercent,
    allowStacking: program.allowStacking,
    marketplaceEnabled: program.marketplaceEnabled,
  };
}

/** "1 pieczątka za opłaconą wizytę" or "10 pkt za każde 50,00 zł". */
export function programRule(
  program: LoyaltyProgram,
  t: Dictionary,
  locale: DayLocale,
  currency: string,
): string {
  const l = t.loyalty;
  if (program.mode === 'stamps') {
    return fill(l.ruleStamps, { count: String(program.stampsPerVisit) });
  }
  return fill(l.rulePoints, {
    count: String(program.pointsPerUnit),
    amount: formatPrice(program.spendUnitGrosze, currency, locale),
  });
}

/** "Zniżka 20%" or "Gratis: Strzyżenie" (a service of another salon has no name here). */
export function rewardLabel(
  reward: Pick<LoyaltyReward, 'kind' | 'discountPercent' | 'freeServiceId'>,
  services: Map<string, string>,
  t: Dictionary,
): string {
  const l = t.loyalty;
  if (reward.kind === 'discount_percent') {
    return fill(l.discountLabel, { percent: String(reward.discountPercent ?? 0) });
  }
  const name = (reward.freeServiceId && services.get(reward.freeServiceId)) || l.otherService;
  return fill(l.freeLabel, { service: name });
}

/** "pieczątki: 5" or "pkt: 100". */
export function costText(cost: number, mode: LoyaltyProgram['mode'], t: Dictionary): string {
  return fill(mode === 'stamps' ? t.loyalty.stampsCount : t.loyalty.pointsCount, {
    count: String(cost),
  });
}

/** Cheaper rewards first, as clients see them. */
export function sortedRewards(rewards: LoyaltyReward[]): LoyaltyReward[] {
  return [...rewards]
    .filter((r) => r.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.cost - b.cost || a.name.localeCompare(b.name));
}

export interface RewardForm {
  name: string;
  kind: NewLoyaltyReward['kind'];
  percent: string;
  serviceId: string | null;
  cost: string;
}

export const EMPTY_REWARD: RewardForm = {
  name: '',
  kind: 'discount_percent',
  percent: '',
  serviceId: null,
  cost: '',
};

export type RewardProblem = 'name' | 'percent' | 'service' | 'cost';

/** Checks the "Dodaj nagrodę" form; the limits are the server's. */
export function newReward(
  form: RewardForm,
): { ok: true; reward: NewLoyaltyReward } | { ok: false; problem: RewardProblem } {
  const name = form.name.trim();
  if (name.length < 1 || name.length > 80) return { ok: false, problem: 'name' };
  let discountPercent: number | null = null;
  let freeServiceId: string | null = null;
  if (form.kind === 'discount_percent') {
    const percent = Number(form.percent.trim().replace('%', ''));
    if (!form.percent.trim() || !Number.isInteger(percent) || percent < 1 || percent > 100) {
      return { ok: false, problem: 'percent' };
    }
    discountPercent = percent;
  } else {
    if (!form.serviceId) return { ok: false, problem: 'service' };
    freeServiceId = form.serviceId;
  }
  const cost = Number(form.cost.trim());
  if (!form.cost.trim() || !Number.isInteger(cost) || cost < 1 || cost > 100_000) {
    return { ok: false, problem: 'cost' };
  }
  return { ok: true, reward: { name, kind: form.kind, discountPercent, freeServiceId, cost } };
}

/** "Naliczenie za wizytę · Jan Kowalski". */
export function operationTitle(entry: LoyaltyTransaction, t: Dictionary): string {
  const type = t.loyalty.types[entry.type] ?? entry.type;
  return `${type} · ${entry.customer.name}`;
}

/** "+1 · saldo: 3 · 5 lis 2026, 14:05" — the time in the salon's time zone. */
export function operationLine(
  entry: LoyaltyTransaction,
  t: Dictionary,
  locale: DayLocale,
  timeZone: string,
): string {
  const when = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(entry.createdAt));
  const points = entry.points > 0 ? `+${entry.points}` : String(entry.points);
  return [points, fill(t.loyalty.balanceAfter, { count: String(entry.balanceAfter) }), when].join(
    ' · ',
  );
}
