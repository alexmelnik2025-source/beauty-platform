import type { LoyaltyReward, NewLoyaltyReward } from './api';
import { newReward, type RewardForm, type RewardProblem } from './loyalty';

/**
 * Task 348: "Zmień nagrodę" in the business app (in the cabinet — RewardSheet): a reward of the
 * catalogue gets its form back, and a new or changed reward may say how many days its coupon is
 * valid and for which services it works. No React Native here — tested in Vitest
 * (test/rewardEdit.test.ts).
 */

export interface RewardFormFull extends RewardForm {
  /** Days as typed; '' = no limit. */
  validityDays: string;
  /** Empty = any service. */
  serviceIds: string[];
}

export type RewardFullProblem = RewardProblem | 'validity';

export const EMPTY_REWARD_FULL: RewardFormFull = {
  name: '',
  kind: 'discount_percent',
  percent: '',
  serviceId: null,
  cost: '',
  validityDays: '',
  serviceIds: [],
};

/** The form of a saved reward, as typed. */
export function rewardForm(reward: LoyaltyReward): RewardFormFull {
  return {
    name: reward.name,
    kind: reward.kind,
    percent: reward.discountPercent === null ? '' : String(reward.discountPercent),
    serviceId: reward.freeServiceId,
    cost: String(reward.cost),
    validityDays: reward.couponValidityDays === null ? '' : String(reward.couponValidityDays),
    serviceIds: [...reward.serviceIds],
  };
}

/** Checks the form; the limits are the server's (validity 1–3650 days). */
export function rewardToSave(
  form: RewardFormFull,
): { ok: true; reward: Required<NewLoyaltyReward> } | { ok: false; problem: RewardFullProblem } {
  const base = newReward(form);
  if (!base.ok) return base;
  const days = form.validityDays.trim();
  if (days !== '' && (!/^\d{1,4}$/.test(days) || Number(days) < 1 || Number(days) > 3650)) {
    return { ok: false, problem: 'validity' };
  }
  return {
    ok: true,
    reward: {
      ...base.reward,
      couponValidityDays: days === '' ? null : Number(days),
      serviceIds: [...new Set(form.serviceIds)],
    },
  };
}

/** What `PUT …/rewards/:id` takes: the reward keeps its place in the list. */
export function rewardUpdate(
  saved: Pick<LoyaltyReward, 'sortOrder' | 'version'>,
  reward: Required<NewLoyaltyReward>,
): Required<NewLoyaltyReward> & { sortOrder: number; version: number } {
  return { ...reward, sortOrder: saved.sortOrder, version: saved.version };
}

/** Adds or removes a service of "Kupon tylko na usługi". */
export function toggledService(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((s) => s !== id) : [...ids, id];
}

/**
 * The coupon's limits in short: "kupon ważny 30 dni · tylko: Strzyżenie, Broda" (null when the
 * reward has none). Services of another salon are counted as "usługa innego salonu".
 */
export function rewardLimits(
  reward: Pick<LoyaltyReward, 'couponValidityDays' | 'serviceIds'>,
  services: Map<string, string>,
  l: { validityLine: string; onlyLine: string; otherService: string },
  fill: (text: string, values: Record<string, string>) => string,
): string | null {
  const parts: string[] = [];
  if (reward.couponValidityDays !== null) {
    parts.push(fill(l.validityLine, { days: String(reward.couponValidityDays) }));
  }
  if (reward.serviceIds.length > 0) {
    const names = reward.serviceIds.map((id) => services.get(id) ?? l.otherService);
    parts.push(fill(l.onlyLine, { services: names.join(', ') }));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
