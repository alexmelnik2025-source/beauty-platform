import type { BaseIntegration, BaseSyncRun } from './api';
import { fill, type Dictionary } from './i18n';

/**
 * Task Q4: the "Base" card of "Mój sklep" in the business app — what an owner or a manager needs
 * on the phone: is Base connected, how many products came from it, when prices and stock were
 * last renewed and whether it went well, and "Synchronizuj teraz". Connecting, choosing the
 * catalogue and ticking products stay in the cabinet ("Integracje"). No React Native here, so it
 * is tested with Vitest (test/baseStatus.test.ts).
 */

export type BaseCardState =
  /** No token: one quiet line pointing to the cabinet. */
  | { kind: 'off' }
  /** Connected, but the token must be pasted again or step 2 is not done: fix it in the cabinet. */
  | { kind: 'fix'; reason: 'reconnect' | 'configure' }
  /** Working: products, the last renewal and the button. */
  | { kind: 'on' };

export function baseCardState(status: BaseIntegration): BaseCardState {
  if (!status.connected) return { kind: 'off' };
  if (!status.tokenReadable || status.lastErrorCode === 'BASE_RECONNECT') {
    return { kind: 'fix', reason: 'reconnect' };
  }
  if (!status.inventoryId) return { kind: 'fix', reason: 'configure' };
  return { kind: 'on' };
}

/** Time elapsed since a saved timestamp, or an empty string if the date is unavailable. */
export function agoText(iso: string | null, t: Dictionary, now = new Date()): string {
  const s = t.shop.base;
  if (typeof iso !== 'string') return '';
  const elapsed = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return '';
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return s.justNow;
  if (minutes < 60) return fill(s.minutesAgo, { n: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fill(s.hoursAgo, { n: String(hours) });
  return fill(s.daysAgo, { n: String(Math.floor(hours / 24)) });
}

/** A failed import or renewal in the salon's words; unknown codes get the general sentence. */
export function baseErrorText(code: string, t: Dictionary): string {
  const e = t.shop.base.errors;
  switch (code) {
    case 'BASE_TOKEN_INVALID':
    case 'BASE_RECONNECT':
      return e.token;
    case 'BASE_UNREACHABLE':
      return e.unreachable;
    case 'BASE_SYNC_TOO_SOON':
      return e.tooSoon;
    default:
      return e.other;
  }
}

/** The line under the products: when it was renewed last, or that it failed. */
export function lastSyncLine(status: BaseIntegration, t: Dictionary, now = new Date()): string {
  const s = t.shop.base;
  const when = agoText(status.lastSyncAt ?? status.lastImportAt, t, now);
  if (status.lastErrorCode) {
    const why = baseErrorText(status.lastErrorCode, t);
    return when ? fill(s.failedAt, { when, why }) : why;
  }
  const lastKnown = when || agoText(status.lastImportAt, t, now);
  return lastKnown ? fill(s.syncedAt, { when: lastKnown }) : s.neverSynced;
}

/** What "Synchronizuj teraz" did: "Sprawdzono 12 · zmieniono 2 · brak w Base: 1". */
export function runResultText(run: BaseSyncRun, t: Dictionary): string {
  const s = t.shop.base;
  if (run.errorCode) return baseErrorText(run.errorCode, t);
  const parts = [
    fill(s.checked, { n: String(run.checked) }),
    fill(s.changed, { n: String(run.changed) }),
  ];
  if (run.missing > 0) parts.push(fill(s.missing, { n: String(run.missing) }));
  return parts.join(' · ');
}

/** Only owners and managers see the card (the API refuses others anyway). */
export function canSeeBase(role: 'owner' | 'manager' | 'staff'): boolean {
  return role !== 'staff';
}
