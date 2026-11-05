import type { AuditLog } from './api';
import type { DayLocale } from './day';
import { fill, type Dictionary } from './i18n';

/**
 * "Dziennik zmian" in the business app (task 150; in the cabinet — task 23): who changed what in
 * the salon and when, newest first. No React Native here — tested in Vitest (test/history.test.ts).
 * Only the owner sees it; the server refuses everyone else (403).
 */

export type HistoryEntry = AuditLog['items'][number];

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;

/** Only the owner opens the change log (the API says the same). */
export function mayViewHistory(role: 'owner' | 'manager' | 'staff'): boolean {
  return role === 'owner';
}

/** An older page is added below; an entry already shown is not repeated. */
export function appendPage(shown: HistoryEntry[], page: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set(shown.map((e) => e.id));
  return [...shown, ...page.filter((e) => !seen.has(e.id))];
}

/** "Zmieniono usługę: Strzyżenie" — an action we do not know yet is shown as it is. */
export function historyTitle(entry: HistoryEntry, t: Dictionary): string {
  const action = t.history.actions[entry.action] ?? entry.action;
  return entry.entityName ? `${action}: ${entry.entityName}` : action;
}

/**
 * "Aleksander · 5 lis 2026, 14:05 · dzień: pt., 7 lis" — who, when (in the salon's time zone)
 * and, for a schedule change, which day it is about.
 */
export function historyLine(
  entry: HistoryEntry,
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
  }).format(new Date(entry.at));
  const parts = [entry.actor?.name ?? t.history.system, when];
  if (entry.date) parts.push(fill(t.history.day, { date: dayText(entry.date, locale) }));
  return parts.join(' · ');
}

function dayText(date: string, locale: DayLocale): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
