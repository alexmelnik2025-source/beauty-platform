/**
 * Task 403: "Ostatnio oglądane" on the home page — the salons whose pages were opened last, kept
 * on this device only (nothing is sent anywhere). The client app keeps its own list (task 402).
 */
export interface RecentSalon {
  slug: string;
  name: string;
}

const RECENT_KEY = 'beauty.catalogue.recent';
export const RECENT_MAX = 5;

/** The list with `salon` first (moved up when it was there already), at most RECENT_MAX. */
export function withViewed(list: RecentSalon[], salon: RecentSalon): RecentSalon[] {
  return [salon, ...list.filter((s) => s.slug !== salon.slug)].slice(0, RECENT_MAX);
}

export function recentSalons(): RecentSalon[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
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

export function rememberViewed(salon: RecentSalon): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(withViewed(recentSalons(), salon)));
  } catch {
    // Private mode or blocked storage: the list just is not remembered.
  }
}

/** Task 414: "Wyczyść listę" — forget the salons opened on this device (a shared computer). */
export function forgetRecent(): void {
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    // Nothing was stored.
  }
}
