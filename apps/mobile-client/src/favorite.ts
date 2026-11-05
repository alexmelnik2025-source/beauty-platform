import type { ClientAppointment } from './api';
import type { BookingPreset } from './booking';

/**
 * Task 165d: "your specialist" — in each salon, the specialist the client went to most often
 * (on a tie, the latest one), with the service of their latest visit to them, so the booking
 * opens on that specialist's free times in one tap. Only visits that took place and that the
 * salon still takes online. No React Native here (tested in test/favorite.test.ts).
 */
export interface FavoriteSpecialist {
  slug: string;
  salonName: string;
  staffName: string;
  serviceName: string;
  /** Visits that took place with this specialist. */
  visits: number;
  preset: BookingPreset & { staffId: string };
}

function tookPlace(visit: ClientAppointment, now: number): boolean {
  if (visit.status === 'completed') return true;
  return visit.status === 'confirmed' && Date.parse(visit.end) <= now;
}

export function favoriteSpecialists(
  past: ClientAppointment[],
  limit = 3,
  now = Date.now(),
): FavoriteSpecialist[] {
  // Latest first, so the first visit seen with a specialist is their latest one.
  const visits = past
    .filter((v) => tookPlace(v, now) && v.bookAgain)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const bySalon = new Map<string, Map<string, { latest: ClientAppointment; count: number }>>();
  for (const v of visits) {
    const slug = v.bookAgain!.slug;
    const staff = bySalon.get(slug) ?? new Map();
    const seen = staff.get(v.staff.id);
    if (seen) seen.count += 1;
    else staff.set(v.staff.id, { latest: v, count: 1 });
    bySalon.set(slug, staff);
  }
  const result: FavoriteSpecialist[] = [];
  if (limit <= 0) return result;
  // Map keeps insertion order: salons by their latest visit.
  for (const [slug, staff] of bySalon) {
    let best: { latest: ClientAppointment; count: number } | null = null;
    for (const entry of staff.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    if (!best) continue;
    const v = best.latest;
    result.push({
      slug,
      salonName: v.salon.name,
      staffName: v.staff.displayName,
      serviceName: v.service.name,
      visits: best.count,
      preset: { serviceId: v.bookAgain!.serviceId, staffId: v.staff.id },
    });
    if (result.length >= limit) break;
  }
  return result;
}
