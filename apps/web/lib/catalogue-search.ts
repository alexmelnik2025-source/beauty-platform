import { SPECIALTIES, type Specialty } from './types';

/**
 * Task 180b: what the client searches for on the home page and in the catalogue — kept in the
 * catalogue's address (`/pl/salons?q=strzyżenie&city=Warszawa`), so a search can be shared or
 * opened again with "Back".
 */
export interface CatalogueSearch {
  /** A service or the salon's name. */
  q: string;
  /** Part of the city. */
  city: string;
  /** "W pobliżu": where the client is, from the browser (only after they agree). */
  near: { latitude: number; longitude: number } | null;
  /** A category of the home page (the kind of place). */
  specialty: Specialty | null;
}

export const EMPTY_SEARCH: CatalogueSearch = { q: '', city: '', near: null, specialty: null };

/** The search read from the catalogue's address; anything broken is left out. */
export function readSearch(params: URLSearchParams): CatalogueSearch {
  const near = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(params.get('near') ?? '');
  const specialty = params.get('specialty');
  return {
    q: (params.get('q') ?? '').trim().slice(0, 80),
    city: (params.get('city') ?? '').trim().slice(0, 80),
    near: near ? { latitude: Number(near[1]), longitude: Number(near[2]) } : null,
    specialty: SPECIALTIES.find((kind) => kind === specialty) ?? null,
  };
}

/** The query string of a search (also for the API, which takes the same names). */
export function searchParams(search: CatalogueSearch): URLSearchParams {
  const params = new URLSearchParams();
  if (search.q.trim()) params.set('q', search.q.trim());
  if (search.city.trim()) params.set('city', search.city.trim());
  if (search.near) {
    params.set('near', `${search.near.latitude.toFixed(4)},${search.near.longitude.toFixed(4)}`);
  }
  if (search.specialty) params.set('specialty', search.specialty);
  return params;
}

/** The catalogue's address for a search, e.g. `/pl/salons?q=broda`. */
export function catalogueHref(locale: string, search: CatalogueSearch): string {
  const query = searchParams(search).toString();
  return `/${locale}/salons${query ? `?${query}` : ''}`;
}

/** "W pobliżu": asks the browser where the client is; null when they say no or it fails. */
export function whereAmI(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(null),
      { timeout: 10_000, maximumAge: 600_000 },
    );
  });
}
