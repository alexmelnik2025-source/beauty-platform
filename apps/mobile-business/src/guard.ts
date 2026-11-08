import type { CancellationGuard, GuardedClients } from './api';
import { formatPrice, type DayLocale } from './day';
import { fill, type Dictionary } from './i18n';

/**
 * "Ochrona przed odwołaniami" in the business app (task 207; in the cabinet — task 161): the
 * owner or a manager sees the salon's rules, switches the protection on or off and lifts a
 * client's mark. Task 349: the rules themselves and "what then" are changed here too. No React
 * Native here — tested in Vitest (test/guard.test.ts).
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

export const GUARD_ACTIONS: CancellationGuard['action'][] = ['approval', 'phone_only', 'prepay'];

/** Task 349: "Zmień zasady" — every rule keeps its number even while it is switched off. */
export interface GuardForm {
  changesOn: boolean;
  changes: string;
  windowDays: string;
  lateOn: boolean;
  lateMinutes: string;
  noShowsOn: boolean;
  noShows: string;
  action: CancellationGuard['action'];
}

/** The form of the saved settings (the cabinet's defaults for rules never set). */
export function guardForm(settings: CancellationGuard): GuardForm {
  return {
    changesOn: settings.maxChanges !== null,
    changes: String(settings.maxChanges ?? 3),
    windowDays: String(Math.max(1, Math.round(settings.windowHours / 24))),
    lateOn: settings.lateCancelMinutes !== null,
    lateMinutes: String(settings.lateCancelMinutes ?? 120),
    noShowsOn: settings.maxNoShows !== null,
    noShows: String(settings.maxNoShows ?? 2),
    action: settings.action,
  };
}

/** A whole number in [min, max] as typed, or null. */
function whole(value: string, min: number, max: number): number | null {
  const v = value.trim();
  if (!/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

export type GuardProblem = 'changes' | 'windowDays' | 'lateMinutes' | 'noShows' | 'needRule';

/**
 * Checks the form (the server's limits) and returns the whole settings for `PUT`. A period typed
 * as the same number of days keeps a period the cabinet saved in hours (e.g. 36 h).
 */
export function guardRulesToSave(
  settings: CancellationGuard,
  form: GuardForm,
): { ok: true; save: CancellationGuard } | { ok: false; problem: GuardProblem } {
  let maxChanges: number | null = null;
  let windowHours = settings.windowHours;
  if (form.changesOn) {
    maxChanges = whole(form.changes, 1, 50);
    if (maxChanges === null) return { ok: false, problem: 'changes' };
    const days = whole(form.windowDays, 1, 365);
    if (days === null) return { ok: false, problem: 'windowDays' };
    if (days !== Math.max(1, Math.round(settings.windowHours / 24))) windowHours = days * 24;
  }
  let lateCancelMinutes: number | null = null;
  if (form.lateOn) {
    lateCancelMinutes = whole(form.lateMinutes, 1, 60 * 24 * 7);
    if (lateCancelMinutes === null) return { ok: false, problem: 'lateMinutes' };
  }
  let maxNoShows: number | null = null;
  if (form.noShowsOn) {
    maxNoShows = whole(form.noShows, 1, 20);
    if (maxNoShows === null) return { ok: false, problem: 'noShows' };
  }
  const save: CancellationGuard = {
    ...settings,
    maxChanges,
    windowHours,
    lateCancelMinutes,
    maxNoShows,
    action: form.action,
  };
  if (save.enabled && !hasRule(save)) return { ok: false, problem: 'needRule' };
  return { ok: true, save };
}
