import type { PermissionCatalog, StaffList, TimeBlockList } from './api';
import { timeIn } from './day';
import { fill, type Dictionary } from './i18n';

/** Blocked time of the day calendar (a break, a meeting, the salon closed) — plain functions. */

export type DayBlock = {
  id: string;
  start: string;
  end: string;
  /** null = the whole salon */
  staffId: string | null;
  staff: string | null;
  reason: string | null;
  /** Task 342: blocks made together as "every week"; null = a single block. */
  seriesId: string | null;
};

/** Blocks that touch this day, in time order; a block over midnight shows its local times. */
export function blocksOfDay(
  blocks: TimeBlockList,
  staff: StaffList,
  date: string,
  timeZone: string,
): DayBlock[] {
  const names = new Map(staff.map((s) => [s.id, s.displayName]));
  return blocks
    .filter((b) => !b.deleted && b.date <= date && localDate(b.end, timeZone) >= date)
    .filter((b) => !(localDate(b.end, timeZone) === date && timeIn(b.end, timeZone) === '00:00'))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((b) => ({
      id: b.id,
      start: b.date === date ? timeIn(b.start, timeZone) : '00:00',
      end: localDate(b.end, timeZone) === date ? timeIn(b.end, timeZone) : '24:00',
      staffId: b.staffId,
      staff: b.staffId ? (names.get(b.staffId) ?? null) : null,
      reason: b.reason,
      seriesId: b.seriesId,
    }));
}

/**
 * Whose time may this person block? Owners and managers: anyone or the whole salon (null);
 * a specialist with "blocks own time": only themselves; otherwise nobody.
 */
export function blockTargets(
  me: PermissionCatalog['me'],
  staff: StaffList,
  mineId: string | null,
): { staffId: string | null; name: string | null }[] {
  if (me.role !== 'staff') {
    return [
      { staffId: null, name: null },
      ...staff.filter((s) => s.active).map((s) => ({ staffId: s.id, name: s.displayName })),
    ];
  }
  if (!me.permissions.blockOwnTime || !mineId) return [];
  const own = staff.find((s) => s.id === mineId);
  return own ? [{ staffId: own.id, name: own.displayName }] : [];
}

/** May this person remove the block? The same rule as creating it. */
export function canRemoveBlock(
  block: Pick<DayBlock, 'staffId'>,
  targets: { staffId: string | null }[],
): boolean {
  return targets.some((t) => t.staffId === block.staffId);
}

/** "HH:MM" ± minutes, kept within the day (00:00–24:00). */
export function shiftTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = Math.min(24 * 60, Math.max(0, h * 60 + m + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The next full hour after now in the salon, as "HH:00" (at most 23:00): where a new block starts. */
export function nextFullHour(timeZone: string, now = new Date()): string {
  const [h] = timeIn(now.toISOString(), timeZone).split(':').map(Number) as [number];
  return `${String(Math.min(23, h + 1)).padStart(2, '0')}:00`;
}

/**
 * The moment of a salon-local date and time ("24:00" = the next midnight) as an ISO string
 * with the right offset for that day, e.g. "2026-11-04T14:00:00+01:00".
 */
export function localToIso(date: string, time: string, timeZone: string): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes find the offset also on the days the clock changes.
  let utc = wanted - offsetMs(wanted, timeZone);
  utc = wanted - offsetMs(utc, timeZone);
  const offset = offsetMs(utc, timeZone) / 60_000;
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const local = new Date(utc + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** How far the salon's clock is ahead of UTC at that moment. */
function offsetMs(utc: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(utc / 1000) * 1000;
}

function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Task 342: how many weeks a weekly block may repeat (the server's limits) and the start value. */
export const SERIES_WEEKS = { min: 2, max: 26, start: 8 } as const;

/**
 * Task 342: what to say after a weekly block was saved — "8 blocked", or which days stayed free
 * because visits were already there ("12.11, 19.11").
 */
export function seriesDoneText(
  made: { items: unknown[]; skippedDates: string[] },
  t: Dictionary,
): string {
  if (made.skippedDates.length === 0) {
    return fill(t.blocks.seriesAdded, { count: String(made.items.length) });
  }
  const dates = made.skippedDates.map((d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`).join(', ');
  return fill(t.blocks.seriesSkipped, { count: String(made.items.length), dates });
}
