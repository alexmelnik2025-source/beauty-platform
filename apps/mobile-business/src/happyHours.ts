import type { HappyHourRule, HappyHours, Locale } from './api';

/**
 * "Happy hours" in the business app (task 99): cheaper hours of the salon — the list, a new
 * rule and removing one. The server keeps the whole list and replaces it at once. No React
 * Native here — tested in Vitest (test/happyHours.test.ts).
 */

export type Rule = HappyHours['rules'][number];

const INTL_LOCALE = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' } as const;

/** Short weekday names, Monday (1) to Sunday (7): "pon.", "wt."… */
export function shortWeekday(weekday: number, locale: Locale): string {
  // 2026-11-02 is a Monday.
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(Date.UTC(2026, 10, 1 + weekday, 12)),
  );
}

/** "Codziennie" for all seven days, else the days in order: "wt., czw." */
export function daysText(weekdays: number[], locale: Locale, everyDay: string): string {
  const days = [...new Set(weekdays)].sort((a, b) => a - b);
  if (days.length === 7) return everyDay;
  return days.map((d) => shortWeekday(d, locale)).join(', ');
}

/** Names for the ids of a rule; empty list = everyone (`all`). Unknown ids are left out. */
export function namesText(ids: string[], names: Map<string, string>, all: string): string {
  if (ids.length === 0) return all;
  const known = ids.map((id) => names.get(id)).filter((n): n is string => !!n);
  return known.length > 0 ? known.join(', ') : all;
}

/** "9:00" → "09:00", "24:00" stays; null when it is not a time of day on a 5-minute mark. */
export function parseClock(text: string): string | null {
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m !== 0) || m % 5 !== 0) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type RuleProblem = 'days' | 'clock' | 'hours' | 'percent';

/** Checks the "Dodaj" form; staff are optional (none = everyone). */
export function newRule(form: {
  weekdays: number[];
  start: string;
  end: string;
  percent: string;
  staffIds: string[];
}): { ok: true; rule: HappyHourRule } | { ok: false; problem: RuleProblem } {
  if (form.weekdays.length === 0) return { ok: false, problem: 'days' };
  const start = parseClock(form.start);
  const end = parseClock(form.end);
  if (!start || !end) return { ok: false, problem: 'clock' };
  if (start >= end) return { ok: false, problem: 'hours' };
  const percent = Number(form.percent.trim().replace('%', ''));
  if (!Number.isInteger(percent) || percent < 1 || percent > 90) {
    return { ok: false, problem: 'percent' };
  }
  return {
    ok: true,
    rule: {
      weekdays: [...new Set(form.weekdays)].sort((a, b) => a - b),
      start,
      end,
      discountPercent: percent,
      staffIds: form.staffIds,
      serviceIds: [],
    },
  };
}

/** The list to save: what the server has (without its ids), optionally minus one, plus a new one. */
export function rulesToSave(
  current: Rule[],
  change: { remove?: string; add?: HappyHourRule },
): HappyHourRule[] {
  const kept = current
    .filter((r) => r.id !== change.remove)
    .map((r) => ({
      weekdays: r.weekdays,
      start: r.start,
      end: r.end,
      discountPercent: r.discountPercent,
      staffIds: r.staffIds,
      serviceIds: r.serviceIds,
    }));
  return change.add ? [...kept, change.add] : kept;
}
