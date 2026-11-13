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
    return saved
      .filter(
        (x): x is RecentSalon =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as RecentSalon).slug === 'string' &&
          typeof (x as RecentSalon).name === 'string' &&
          (x as RecentSalon).slug.length > 0,
      )
      .map(({ slug, name }) => ({ slug, name }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}
