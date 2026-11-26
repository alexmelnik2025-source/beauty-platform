/**
 * Task 180b: "W pobliżu" — where the client is, asked only when they tap it. Uses the standard
 * geolocation of the web build and of phones that provide it; null when there is none, the
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

export function locate(geolocation?: Geolocation, timeoutMs = 10_000): Promise<Place | null> {
  return new Promise((resolve) => {
    // The provider's timeout starts after the user has answered the permission prompt.
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const finish = (place: Place | null) => {
      clearTimeout(timer);
      resolve(place);
    };
    try {
      const provider =
        geolocation ??
        (globalThis as { navigator?: { geolocation?: Geolocation } }).navigator?.geolocation;
      if (!provider) {
        finish(null);
        return;
      }
      provider.getCurrentPosition(
        ({ coords }) => finish({ latitude: coords.latitude, longitude: coords.longitude }),
        () => finish(null),
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 },
      );
    } catch {
      finish(null);
    }
  });
}
