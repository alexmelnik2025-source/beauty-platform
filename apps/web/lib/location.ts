/**
 * Task 180b: "W pobliżu" — where the client is, asked only when they tap it. Uses the browser's
 * geolocation; null when there is none, the
 * client refuses or it takes too long (then the client types a city instead).
 */
export type Place = { latitude: number; longitude: number };

type Geolocation = {
  getCurrentPosition(
    ok: (position: { coords: Place }) => void,
    fail: (error: unknown) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void;
};

export function locate(
  geolocation: Geolocation | undefined = (
    globalThis as { navigator?: { geolocation?: Geolocation } }
  ).navigator?.geolocation,
  timeoutMs = 10_000,
): Promise<Place | null> {
  if (!geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 },
      );
    } catch {
      resolve(null);
    }
  });
}

/** "1,2" — kilometres, one decimal below 10 km, as the language writes numbers. */
export function formatKm(km: number, localeTag: string): string {
  const digits = km < 10 ? 1 : 0;
  return new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(km);
}

/** The stars of a salon's card ("4,5"); null without reviews. */
export function formatRating(
  salon: { rating: number | null; reviewCount: number },
  localeTag: string,
): string | null {
  if (salon.rating === null || salon.reviewCount === 0) return null;
  return new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(salon.rating);
}
