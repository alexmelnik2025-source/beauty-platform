import type { DirectorySalon, Locale, PublicLocation } from './api';
import { LOCALE_TAGS } from './format';

/** Formatting and grouping for the catalogue and the salon page — no React Native here. */

/** Lower case, without Polish/other accents: "Łódź" → "lodz". */
export function plain(text: string): string {
  return text.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** Salons whose name, city or address contain every word typed (accents do not matter). */
export function filterSalons(items: DirectorySalon[], query: string): DirectorySalon[] {
  const words = plain(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((s) => {
    const text = plain(`${s.name} ${s.city} ${s.addressLine} ${s.postalCode}`);
    return words.every((w) => text.includes(w));
  });
}

/** "45 min", "1 h 15 min" — `h` and `min` come from the dictionary. */
export function durationText(minutes: number, units: { h: string; min: string }): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} ${units.min}`;
  return m === 0 ? `${h} ${units.h}` : `${h} ${units.h} ${m} ${units.min}`;
}

export type ServiceGroup = {
  id: string | null;
  name: string | null;
  services: PublicLocation['services'];
};

/** Price list in the salon's order of groups; services without a group come last. */
export function serviceGroups(salon: PublicLocation): ServiceGroup[] {
  const groups: ServiceGroup[] = salon.categories.map((c) => ({
    id: c.id,
    name: c.name,
    services: salon.services.filter((s) => s.categoryId === c.id),
  }));
  const known = new Set(salon.categories.map((c) => c.id));
  groups.push({
    id: null,
    name: null,
    services: salon.services.filter((s) => s.categoryId === null || !known.has(s.categoryId)),
  });
  return groups.filter((g) => g.services.length > 0);
}

export function weekdayName(weekday: number, locale: Locale): string {
  // 2024-01-01 was a Monday (ISO weekday 1).
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { timeZone: 'UTC', weekday: 'long' }).format(
    new Date(Date.UTC(2024, 0, weekday)),
  );
}

/** Monday…Sunday: "09:00–18:00", "09:00–13:00, 14:00–18:00" or null when closed. */
export function openingRows(
  salon: PublicLocation,
  locale: Locale,
): { weekday: number; name: string; hours: string | null }[] {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const day = salon.openingHours.find((d) => d.weekday === weekday);
    const hours = day?.intervals.length
      ? day.intervals.map((i) => `${i.start}–${i.end}`).join(', ')
      : null;
    return { weekday, name: weekdayName(weekday, locale), hours };
  });
}

/** "ul. Józefa Bema 91, 01-233 Warszawa" */
export function addressText(
  s: Pick<DirectorySalon, 'addressLine' | 'postalCode' | 'city'>,
): string {
  return `${s.addressLine}, ${`${s.postalCode} ${s.city}`.trim()}`;
}

/**
 * Task 359: "Jak dojechać" — directions to the salon in the phone's maps, free and without a
 * key: Apple Maps on an iPhone, Google Maps elsewhere (its app on Android, the site in a
 * browser). The salon's name goes with the address, so the maps find the right door.
 */
export function directionsUrl(
  s: Pick<DirectorySalon, 'name' | 'addressLine' | 'postalCode' | 'city'>,
  platform: 'ios' | 'android' | 'web' | string,
): string {
  const destination = encodeURIComponent(`${s.name}, ${addressText(s)}`);
  return platform === 'ios'
    ? `https://maps.apple.com/?daddr=${destination}`
    : `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
}

/** The specialist's trades, main one first, in the person's language (custom name last). */
export function specialtyText(
  staff: PublicLocation['staff'][number],
  names: Record<PublicLocation['staff'][number]['specialties'][number], string>,
): string {
  const list = staff.specialties.map((s) => names[s]);
  if (staff.customSpecialty) list.push(staff.customSpecialty);
  return list.join(' · ');
}
