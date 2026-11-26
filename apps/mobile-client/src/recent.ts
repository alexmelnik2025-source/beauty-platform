/** Task 402: a salon the client opened, remembered on this device only. */
export interface RecentSalon {
  slug: string;
  name: string;
}

/** How many salons "Ostatnio oglądane" keeps. */
export const RECENT_MAX = 5;

/** The list with `salon` first (moved up when it was there already), at most RECENT_MAX. */
export function rememberViewed(list: RecentSalon[], salon: RecentSalon): RecentSalon[] {
  return [salon, ...list.filter((s) => s.slug !== salon.slug)].slice(0, RECENT_MAX);
}

/** What was stored, without anything broken or foreign in it. */
export function parseRecent(raw: string | null): RecentSalon[] {
  try {
    const saved: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(saved)) return [];
    const salons = new Map<string, RecentSalon>();
    for (const entry of saved) {
      if (
        !entry ||
        typeof entry.slug !== 'string' ||
        !entry.slug.trim() ||
        typeof entry.name !== 'string' ||
        !entry.name.trim()
      )
        continue;
      if (salons.has(entry.slug)) continue;
      salons.set(entry.slug, { slug: entry.slug, name: entry.name });
      if (salons.size === RECENT_MAX) break;
    }
    return [...salons.values()];
  } catch {
    return [];
  }
}
