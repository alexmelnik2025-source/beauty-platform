import type { CustomerDetail, LoyaltyAccount, PermissionCatalog } from './api';
import type { DayLocale } from './day';

/** Client list and client card of the business app — plain functions, tested with Vitest. */

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;

/**
 * May this person change a client's note and tags? Owners and managers may;
 * a specialist needs both "sees notes" and "edits notes" (the server checks the same).
 */
export function canEditNotes(me: PermissionCatalog['me']): boolean {
  if (me.role !== 'staff') return true;
  return me.permissions.viewClientNotes && me.permissions.editClientNotes;
}

/** "vip, stały klient , vip" → ['vip', 'stały klient']: up to 10 tags of up to 30 characters. */
export function parseTags(input: string): string[] {
  const tags = input
    .split(',')
    .map((tag) => tag.trim().slice(0, 30))
    .filter((tag) => tag.length > 0);
  return [...new Set(tags)].slice(0, 10);
}

export type ClientVisit = CustomerDetail['visits'][number];

/** Visits of the card in this salon: upcoming first (soonest first), then past (newest first). */
export function splitVisits(
  visits: ClientVisit[],
  locationId: string,
  now = new Date(),
): { upcoming: ClientVisit[]; past: ClientVisit[] } {
  const here = visits.filter((v) => v.locationId === locationId);
  const upcoming = here
    .filter((v) => Date.parse(v.start) >= now.getTime() && v.status === 'confirmed')
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const past = here
    .filter((v) => !upcoming.includes(v))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return { upcoming, past };
}

/** How many visits the client completed in this salon (shown as "visits: 7"). */
export function completedCount(visits: ClientVisit[], locationId: string): number {
  return visits.filter((v) => v.locationId === locationId && v.status === 'completed').length;
}

/** "12.11.2026, 14:30" in the salon's time zone. */
export function visitWhen(iso: string, timeZone: string, locale: DayLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export type ClientCoupon = LoyaltyAccount['coupons'][number];

/**
 * The bonus part of the card: null when the client has nothing in the program yet
 * (no stamps or points ever, no coupons, the salon has no tiers).
 */
export function bonusSummary(
  account: LoyaltyAccount,
  now = new Date(),
): {
  mode: LoyaltyAccount['mode'];
  balance: number;
  tier: string | null;
  coupons: ClientCoupon[];
} | null {
  const coupons = account.coupons.filter(
    (c) =>
      c.status === 'active' && (c.expiresAt === null || Date.parse(c.expiresAt) > now.getTime()),
  );
  const tier = account.tier?.current
    ? `${account.tier.current.name}${account.tier.current.discountPercent > 0 ? ` · −${account.tier.current.discountPercent}%` : ''}`
    : null;
  if (account.lifetimeEarned === 0 && account.balance === 0 && coupons.length === 0 && !tier) {
    return null;
  }
  return { mode: account.mode, balance: account.balance, tier, coupons };
}

/** "do 31.12.2026" — the last day of a coupon, in the salon's time zone. */
export function dateIn(iso: string, timeZone: string, locale: DayLocale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(iso));
}
