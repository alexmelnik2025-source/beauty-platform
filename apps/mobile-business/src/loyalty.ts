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

/**
 * Task 344: "Zasady programu" in the business app — the kind of program and how much a paid visit
 * earns, as typed. Amounts in the salon's currency ("50" or "50,50"), empty validity = no limit.
 */
export interface RulesForm {
  mode: LoyaltyProgram['mode'];
  stampsPerVisit: string;
  pointsPerUnit: string;
  spendUnit: string;
  minSpend: string;
  validityDays: string;
  maxDiscountPercent: string;
  allowStacking: boolean;
}

export type RulesProblem =
  | 'stampsPerVisit'
  | 'pointsPerUnit'
  | 'spendUnit'
  | 'minSpend'
  | 'validityDays'
  | 'maxDiscountPercent';

const money = (grosze: number) =>
  grosze % 100 === 0 ? String(grosze / 100) : (grosze / 100).toFixed(2).replace('.', ',');

export function rulesForm(program: LoyaltyProgram): RulesForm {
  return {
    mode: program.mode,
    stampsPerVisit: String(program.stampsPerVisit),
    pointsPerUnit: String(program.pointsPerUnit),
    spendUnit: money(program.spendUnitGrosze),
    minSpend: money(program.minSpendGrosze),
    validityDays: program.pointsValidityDays === null ? '' : String(program.pointsValidityDays),
    maxDiscountPercent: String(program.maxDiscountPercent),
    allowStacking: program.allowStacking,
  };
}

/** A whole number within the server's limits, or null. */
function whole(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** "50" or "50,50" → 5050 grosze; null when it is not an amount. */
function grosze(text: string, min: number): number | null {
  const t = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100);
  return n >= min && n <= 10_000_000 ? n : null;
}

/**
 * Checks the form and returns the whole settings for the server (the switch, the marketplace
 * mark and the version stay as read). The fields of the other kind keep their saved values.
 */
export function rulesToSave(
  program: LoyaltyProgram,
  form: RulesForm,
): { ok: true; save: LoyaltyProgramSave } | { ok: false; problem: RulesProblem } {
  const save = programToSave(program, program.enabled);
  save.mode = form.mode;
  if (form.mode === 'stamps') {
    const stamps = whole(form.stampsPerVisit, 0, 100);
    if (stamps === null) return { ok: false, problem: 'stampsPerVisit' };
    save.stampsPerVisit = stamps;
  } else {
    const points = whole(form.pointsPerUnit, 0, 100_000);
    if (points === null) return { ok: false, problem: 'pointsPerUnit' };
    const unit = grosze(form.spendUnit, 1);
    if (unit === null) return { ok: false, problem: 'spendUnit' };
    save.pointsPerUnit = points;
    save.spendUnitGrosze = unit;
    if (form.validityDays.trim() === '') {
      save.pointsValidityDays = null;
    } else {
      const days = whole(form.validityDays, 1, 3650);
      if (days === null) return { ok: false, problem: 'validityDays' };
      save.pointsValidityDays = days;
    }
  }
  const min = form.minSpend.trim() === '' ? 0 : grosze(form.minSpend, 0);
  if (min === null) return { ok: false, problem: 'minSpend' };
  save.minSpendGrosze = min;
  const max = whole(form.maxDiscountPercent, 0, 100);
  if (max === null) return { ok: false, problem: 'maxDiscountPercent' };
  save.maxDiscountPercent = max;
  save.allowStacking = form.allowStacking;
  return { ok: true, save };
}
