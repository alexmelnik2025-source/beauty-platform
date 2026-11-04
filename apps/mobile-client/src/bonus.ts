import type { ClientLoyaltyCard, Locale } from './api';
import { formatPrice, LOCALE_TAGS } from './format';
import { fill, type Dictionary } from './i18n';

/**
 * "My bonuses" as the client reads it: what a reward gives, how far the next one is, how
 * points are earned. The same wording as the web tab. No React Native here — tested in Vitest.
 */

type Reward = ClientLoyaltyCard['rewards'][number];
type Coupon = ClientLoyaltyCard['coupons'][number];

/** Stamp cards longer than this are shown as a bar instead of single stamps. */
export const MAX_STAMPS_DRAWN = 12;

/** "Zniżka 25%" / "Gratis: Broda". */
export function rewardText(
  t: Dictionary,
  r: Pick<Reward | Coupon, 'kind' | 'discountPercent' | 'freeServiceName'>,
): string {
  return r.kind === 'discount_percent'
    ? fill(t.bonuses.discountLabel, { percent: String(r.discountPercent ?? 0) })
    : fill(t.bonuses.freeLabel, { service: r.freeServiceName ?? '' });
}

/** "Do „−25%” zostało wizyt: 1"; null when every reward can already be taken. */
export function nextText(t: Dictionary, card: ClientLoyaltyCard): string | null {
  const next = card.next;
  if (!next) return null;
  const reward = card.rewards.find((r) => r.id === next.rewardId);
  if (!reward) return null;
  if (next.visits !== null) {
    return fill(t.bonuses.nextVisits, { count: String(next.visits), reward: reward.name });
  }
  return fill(card.mode === 'stamps' ? t.bonuses.nextStamps : t.bonuses.nextPoints, {
    count: String(next.missing),
    reward: reward.name,
  });
}

/** The best reward the client can already take (rewards come cheapest first). */
export function readyReward(card: ClientLoyaltyCard): Reward | undefined {
  return [...card.rewards].reverse().find((r) => r.missing === 0);
}

/** "Pieczątki za opłaconą wizytę: 1 · od 50,00 zł za wizytę" — how the salon gives bonuses. */
export function earningText(t: Dictionary, card: ClientLoyaltyCard, locale: Locale): string {
  const e = card.earning;
  const parts = [
    card.mode === 'stamps'
      ? fill(t.bonuses.earnStamps, { count: String(e.stampsPerVisit) })
      : fill(t.bonuses.earnPoints, {
          count: String(e.pointsPerUnit),
          amount: formatPrice(e.spendUnitGrosze, card.currency, locale),
        }),
  ];
  if (e.minSpendGrosze > 0) {
    parts.push(
      fill(t.bonuses.minSpend, { amount: formatPrice(e.minSpendGrosze, card.currency, locale) }),
    );
  }
  if (card.mode === 'points' && e.pointsValidityDays) {
    parts.push(fill(t.bonuses.validity, { days: String(e.pointsValidityDays) }));
  }
  return parts.join(' · ');
}

export type Progress =
  | null
  | {
      kind: 'stamps';
      label: string;
      /** One per stamp of the card: collected, and whether a reward is at this stamp. */
      stamps: { on: boolean; reward: boolean }[];
    }
  | { kind: 'bar'; label: string; value: number; max: number };

/** A stamp card (a circle per stamp, rewards marked) or a bar to the next reward. */
export function progress(t: Dictionary, card: ClientLoyaltyCard): Progress {
  const top = card.rewards.at(-1)?.cost ?? 0;
  if (top === 0) return null;
  const label = fill(t.bonuses.progressLabel, {
    count: String(Math.min(card.balance, top)),
    total: String(top),
  });
  if (card.mode === 'stamps' && top <= MAX_STAMPS_DRAWN) {
    const marks = new Set(card.rewards.map((r) => r.cost));
    return {
      kind: 'stamps',
      label,
      stamps: Array.from({ length: top }, (_, i) => ({
        on: i < card.balance,
        reward: marks.has(i + 1),
      })),
    };
  }
  const goal = card.next
    ? (card.rewards.find((r) => r.id === card.next?.rewardId)?.cost ?? top)
    : top;
  return { kind: 'bar', label, value: Math.min(card.balance, goal), max: goal };
}

/** "4 lis 2026" — dates of coupons and history. */
export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

/** "+1" / "−3" for the history. */
export function signedPoints(points: number): string {
  return points > 0 ? `+${points}` : String(points);
}

/** The client's tier at the salon (task 10e): its name and how far the next one is; null = no tiers. */
export function tierText(
  t: Dictionary,
  card: ClientLoyaltyCard,
  locale: Locale,
): { title: string; detail: string } | null {
  const tier = card.tier;
  if (!tier) return null;
  const title = tier.current
    ? fill(t.bonuses.tier, { name: tier.current.name })
    : t.bonuses.tierNone;
  const detail = !tier.next
    ? t.bonuses.tierTop
    : tier.basis === 'visits'
      ? fill(t.bonuses.tierNextVisits, { name: tier.next.name, count: String(tier.next.missing) })
      : fill(t.bonuses.tierNextSpend, {
          name: tier.next.name,
          amount: formatPrice(tier.next.missing, card.currency, locale),
        });
  return { title, detail };
}
