import type { ServiceCategoryList, ServiceChange, ServiceList } from './api';

/**
 * "Usługi" in the business app (task 93): the price list by category, and the owner's quick
 * changes — price, duration, bookable online. No React Native here — tested in Vitest
 * (test/services.test.ts). The server checks the rights and the values again.
 */

export type Service = ServiceList[number];
export interface ServiceGroup {
  /** null = services without a category (shown last). */
  name: string | null;
  services: Service[];
}

const byOrder = (a: Service, b: Service) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** Categories in the salon's order; empty categories are left out. */
export function priceList(services: ServiceList, categories: ServiceCategoryList): ServiceGroup[] {
  const groups: ServiceGroup[] = [...categories]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => ({
      name: c.name,
      services: services.filter((s) => s.categoryId === c.id).sort(byOrder),
    }));
  const known = new Set(categories.map((c) => c.id));
  const rest = services.filter((s) => !s.categoryId || !known.has(s.categoryId)).sort(byOrder);
  if (rest.length > 0) groups.push({ name: null, services: rest });
  return groups.filter((g) => g.services.length > 0);
}

/**
 * Task 253: the whole order after moving one service a place up (-1) or down (+1) within its
 * category — the server takes every service of the salon once. null at the edge of the category.
 */
export function movedOrder(groups: ServiceGroup[], id: string, step: -1 | 1): string[] | null {
  const group = groups.find((g) => g.services.some((s) => s.id === id));
  if (!group) return null;
  const index = group.services.findIndex((s) => s.id === id);
  const target = index + step;
  if (target < 0 || target >= group.services.length) return null;
  return groups.flatMap((g) => {
    const ids = g.services.map((s) => s.id);
    if (g !== group) return ids;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    return ids;
  });
}

/** Why clients cannot book the service online, if they cannot. */
export function bookingProblem(service: Service): 'hidden' | 'nobody' | null {
  if (!service.active) return 'hidden';
  if (service.staffIds.length === 0) return 'nobody';
  return null;
}

/** "1 h 20 min", "45 min", "2 h" — units from the dictionary. */
export function durationText(minutes: number, units: { h: string; min: string }): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} ${units.min}`;
  return m === 0 ? `${h} ${units.h}` : `${h} ${units.h} ${m} ${units.min}`;
}

/** 9050 → "90,50", 9000 → "90" — for the price field. */
export function priceInput(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const cents = hundredths % 100;
  return cents === 0 ? String(whole) : `${whole},${String(cents).padStart(2, '0')}`;
}

/** "90", "90,5", "90.50", "1 200" → hundredths; null when it is not a price. */
export function parsePrice(text: string): number | null {
  const compact = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(compact)) return null;
  const value = Math.round(Number(compact) * 100);
  return value <= 10_000_000 ? value : null;
}

/** Minutes in 5-minute steps, 5 to 480 (as the server allows); null otherwise. */
export function parseDuration(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 5 || value > 480 || value % 5 !== 0) return null;
  return value;
}

export type ServiceProblem = 'price' | 'duration';

/** Only what changed (and the version that was read); `null` change = nothing to save. */
export function serviceChange(
  service: Service,
  form: { price: string; duration: string; active: boolean },
): { ok: true; change: ServiceChange | null } | { ok: false; problem: ServiceProblem } {
  const price = parsePrice(form.price);
  if (price === null) return { ok: false, problem: 'price' };
  const duration = parseDuration(form.duration);
  if (duration === null) return { ok: false, problem: 'duration' };
  const change: ServiceChange = { version: service.version };
  if (price !== service.priceGrosze) change.priceGrosze = price;
  if (duration !== service.durationMinutes) change.durationMinutes = duration;
  if (form.active !== service.active) change.active = form.active;
  return { ok: true, change: Object.keys(change).length > 1 ? change : null };
}
