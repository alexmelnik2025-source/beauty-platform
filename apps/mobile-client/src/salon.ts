import type { DirectorySalon, Locale, PublicLocation } from './api';
import { LOCALE_TAGS } from './format';
import { fill } from './i18n';

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

interface Interval {
  start: string;
  end: string;
}

/** Task 362: the salon now — "Otwarte · do 20:00", "Zamknięte · otwarcie o 10:00" and so on. */
export type OpenStatus =
  | { kind: 'open'; until: string }
  | { kind: 'opensToday'; at: string }
  | { kind: 'opensLater'; inDays: number; weekday: number; at: string }
  | { kind: 'closed' };

const clockMinutes = (clock: string) => {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Local date, ISO weekday and minutes after midnight of an instant in a time zone. */
export function salonNow(
  instant: number,
  timeZone: string,
): { date: string; weekday: number; minute: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant))) {
    p[part.type] = part.value;
  }
  const date = `${p.year}-${p.month}-${p.day}`;
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return { date, weekday, minute: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/**
 * Task 362: today's real hours come from the API (special days, vacations and salon-wide
 * blocks included); the next days — from the weekly table. Same logic as the web's
 * lib/open-status.ts.
 */
export function openStatus(
  salon: Pick<PublicLocation, 'openingHours' | 'todayHours'>,
  now: { date: string; weekday: number; minute: number },
): OpenStatus {
  const weekdayHours = (weekday: number) =>
    salon.openingHours.find((d) => d.weekday === weekday)?.intervals ?? [];
  const sorted = (list: Interval[]) =>
    [...list].sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start));
  const hours = sorted(
    salon.todayHours.date === now.date ? salon.todayHours.intervals : weekdayHours(now.weekday),
  );
  const current = hours.find(
    (i) => clockMinutes(i.start) <= now.minute && now.minute < clockMinutes(i.end),
  );
  if (current) {
    // Hours that continue without a break (one specialist until 14:00, the next from 14:00).
    let until = current.end;
    for (const i of hours) {
      if (clockMinutes(i.start) <= clockMinutes(until) && clockMinutes(i.end) > clockMinutes(until))
        until = i.end;
    }
    return { kind: 'open', until };
  }
  const later = hours.find((i) => clockMinutes(i.start) > now.minute);
  if (later) return { kind: 'opensToday', at: later.start };
  for (let inDays = 1; inDays <= 7; inDays++) {
    const weekday = ((now.weekday - 1 + inDays) % 7) + 1;
    const first = sorted(weekdayHours(weekday))[0];
    if (first) return { kind: 'opensLater', inDays, weekday, at: first.start };
  }
  return { kind: 'closed' };
}

/** The status as a line for the salon page, in the person's language. */
export function openStatusText(
  status: OpenStatus,
  t: {
    openUntil: string;
    openUntilMidnight: string;
    opensToday: string;
    opensLater: string;
    tomorrow: string;
    closedNow: string;
  },
  locale: Locale,
): string {
  switch (status.kind) {
    case 'open':
      return status.until === '24:00'
        ? t.openUntilMidnight
        : fill(t.openUntil, { time: status.until });
    case 'opensToday':
      return fill(t.opensToday, { time: status.at });
    case 'opensLater':
      return fill(t.opensLater, {
        day: status.inDays === 1 ? t.tomorrow : weekdayName(status.weekday, locale),
        time: status.at,
      });
    case 'closed':
      return t.closedNow;
  }
}
