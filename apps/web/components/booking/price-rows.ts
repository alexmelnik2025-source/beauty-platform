import type { PublicLocation } from '@/lib/types';

type Staff = PublicLocation['staff'][number];
type Service = PublicLocation['services'][number];

/** One line under a service on the price list: the specialists with the same price and length. */
export interface PriceRow {
  staff: Staff[];
  priceGrosze: number;
  durationMinutes: number;
}

/**
 * Task 70b: a service's specialists grouped by their own price and duration (tasks 62, 70a),
 * cheapest first, in the salon's order of specialists within a row ("ILYA, NAZAR — 162 zł").
 */
export function priceRows(service: Service, staff: Staff[]): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const s of staff) {
    if (!s.serviceIds.includes(service.id)) continue;
    const own = s.prices.find((p) => p.serviceId === service.id);
    const priceGrosze = own?.priceGrosze ?? service.priceGrosze;
    const durationMinutes = own?.durationMinutes ?? service.durationMinutes;
    const row = rows.find(
      (r) => r.priceGrosze === priceGrosze && r.durationMinutes === durationMinutes,
    );
    if (row) row.staff.push(s);
    else rows.push({ staff: [s], priceGrosze, durationMinutes });
  }
  return rows.sort(
    (a, b) => a.priceGrosze - b.priceGrosze || a.durationMinutes - b.durationMinutes,
  );
}

/** "1g 20min", "45min", "2g" — the length of a visit the way the price list shows it. */
export function formatLength(minutes: number, hoursShort: string, minutesShort: string): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  // One-letter hours stick to the number ("1g 20min"); words get a space ("1 год 20 хв").
  const sp = hoursShort.length > 1 ? ' ' : '';
  const mins = `${m}${sp}${minutesShort}`;
  if (h === 0) return mins;
  return m ? `${h}${sp}${hoursShort} ${mins}` : `${h}${sp}${hoursShort}`;
}
