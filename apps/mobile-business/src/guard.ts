import type { CancellationGuard, GuardedClients } from './api';
import { formatPrice, type DayLocale } from './day';
import { fill, type Dictionary } from './i18n';

/**
 * "Ochrona przed odwołaniami" in the business app (task 207; in the cabinet — task 161): the
 * owner or a manager sees the salon's rules, switches the protection on or off and lifts a
 * client's mark. The rules themselves are changed in the cabinet. No React Native here —
 * tested in Vitest (test/guard.test.ts).
 */

export type MarkedClient = GuardedClients['items'][number];

/** Owners and managers only (the API says the same). */
export function mayManageGuard(role: 'owner' | 'manager' | 'staff'): boolean {
  return role !== 'staff';
}

/** Switching on needs at least one rule (the server refuses it otherwise). */
export function hasRule(settings: CancellationGuard): boolean {
  return (
    settings.maxChanges !== null ||
    settings.lateCancelMinutes !== null ||
    settings.maxNoShows !== null
  );
}

/** The settings as they are, only switched on or off. */
export function guardToSave(settings: CancellationGuard, enabled: boolean): CancellationGuard {
  return { ...settings, enabled };
}

/** One line per rule that is set: "3 odwołania lub przeniesienia w ciągu 30 dni"… */
export function ruleLines(settings: CancellationGuard, t: Dictionary): string[] {
  const g = t.guard;
  const lines: string[] = [];
  if (settings.maxChanges !== null) {
    const days = settings.windowHours % 24 === 0;
    lines.push(
      fill(days ? g.ruleChangesDays : g.ruleChangesHours, {
        n: String(settings.maxChanges),
        period: String(days ? settings.windowHours / 24 : settings.windowHours),
      }),
    );
  }
  if (settings.lateCancelMinutes !== null) {
    lines.push(fill(g.ruleLate, { min: String(settings.lateCancelMinutes) }));
  }
  if (settings.maxNoShows !== null) {
    lines.push(fill(g.ruleNoShows, { n: String(settings.maxNoShows) }));
  }
  return lines;
}

/** "Co wtedy: Tylko telefonicznie". */
export function actionLine(action: CancellationGuard['action'], t: Dictionary): string {
  return fill(t.guard.then, { action: t.guard.actions[action] });
}

/** Why the client is marked: "nieobecności: 2 · Nieodbyte wizyty: 180,00 zł". */
export function clientReasons(
  client: MarkedClient,
  currency: string,
  t: Dictionary,
  locale: DayLocale,
): string {
  const c = t.clients.guard;
  const parts: string[] = [];
  if (client.reasons.includes('changes')) {
    parts.push(fill(c.reasonChanges, { n: String(client.changes) }));
  }
  if (client.reasons.includes('late_cancel')) {
    parts.push(fill(c.reasonLate, { n: String(client.lateCancellations) }));
  }
  if (client.reasons.includes('no_shows')) {
    parts.push(fill(c.reasonNoShows, { n: String(client.noShows) }));
  }
  if (client.noShowAmountGrosze > 0) {
    parts.push(fill(c.owes, { sum: formatPrice(client.noShowAmountGrosze, currency, locale) }));
  }
  return parts.join(' · ');
}
