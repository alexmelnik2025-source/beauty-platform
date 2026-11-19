/**
 * Task Q2 (part 4): the "Install the app" banner on a salon's booking page and the way the
 * installed app continues the booking from the same place.
 *
 * The banner must never stand between the client and the "Book" button (owner's rule of
 * minimalism): it is one small row, closes with one tap and then stays away for a month.
 */

/** When the client closed the banner, it stays hidden on this device for this long. */
export const HIDE_DAYS = 30;
const HIDDEN_KEY = 'bp_install_banner_hidden';

/** How long "continue the booking" is offered after the app was installed. */
export const RESUME_HOURS = 24;
const RESUME_KEY = 'bp_resume_booking';

/** Where the native apps live once they are published; all empty until then (`.env`). */
export interface StoreLinks {
  /** App Store page of the client app (iPhone). */
  appStoreUrl: string | null;
  /** Google Play page of the client app (Android). */
  playStoreUrl: string | null;
  /** Numeric App Store id for Safari's own "Smart App Banner" (meta apple-itunes-app). */
  iosAppId: string | null;
}

export const NO_STORES: StoreLinks = { appStoreUrl: null, playStoreUrl: null, iosAppId: null };

/** Only https links, so a wrong value in `.env` cannot send clients anywhere odd. */
function httpsOrNull(value: string | undefined): string | null {
  const url = value?.trim() ?? '';
  return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

/** Reads the store links from the server environment (server components only). */
export function storeLinksFromEnv(env: NodeJS.ProcessEnv = process.env): StoreLinks {
  const id = env.IOS_APP_ID?.trim() ?? '';
  return {
    appStoreUrl: httpsOrNull(env.APP_STORE_URL),
    playStoreUrl: httpsOrNull(env.PLAY_STORE_URL),
    iosAppId: /^\d{6,12}$/.test(id) ? id : null,
  };
}

/** The client app's own link scheme and Android package (apps/mobile-client/app.json). */
export const APP_SCHEME = 'beauty-client';
export const ANDROID_PACKAGE = 'dev.beautyplatform.client';

/** Where the client is in the booking: the installed app opens the same salon, service and specialist. */
export interface BookingPlace {
  slug: string;
  salonName: string;
  serviceId?: string;
  staffId?: string;
}

/** Query that makes the booking page skip to the chosen service and specialist (`?service=…&staff=…`). */
export function placeQuery(place: BookingPlace): string {
  const params = new URLSearchParams();
  if (place.serviceId) params.set('service', place.serviceId);
  if (place.staffId && place.serviceId) params.set('staff', place.staffId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Deep link into the native client app: beauty-client://b/{salon}?service=…&staff=… */
export function appDeepLink(place: BookingPlace): string {
  return `${APP_SCHEME}://b/${encodeURIComponent(place.slug)}${placeQuery(place)}`;
}

/**
 * Android "intent" link: opens the client app at this salon when it is installed, otherwise
 * Google Play (browser_fallback_url). Only when the Play page is known.
 */
export function androidIntentLink(place: BookingPlace, stores: StoreLinks): string | null {
  if (!stores.playStoreUrl) return null;
  const path = `b/${encodeURIComponent(place.slug)}${placeQuery(place)}`;
  return (
    `intent://${path}#Intent;scheme=${APP_SCHEME};package=${ANDROID_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(stores.playStoreUrl)};end`
  );
}

/** Content of Safari's `apple-itunes-app` meta: the App Store id and the page to reopen in the app. */
export function smartAppBannerContent(stores: StoreLinks, pageUrl: string): string | null {
  if (!stores.iosAppId) return null;
  // Commas separate the fields, so none may be inside the argument.
  return `app-id=${stores.iosAppId}, app-argument=${pageUrl.replace(/,/g, '%2C')}`;
}

// ── On this device (browser only) ─────────────────────────

/** Whether the client closed the banner less than HIDE_DAYS ago. */
export function bannerHidden(now = Date.now()): boolean {
  try {
    const until = Number(window.localStorage.getItem(HIDDEN_KEY) ?? '0');
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

/** Remembers that the client closed the banner. */
export function hideBanner(now = Date.now()): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, String(now + HIDE_DAYS * 24 * 60 * 60 * 1000));
  } catch {
    // Blocked storage: the banner simply comes back next time.
  }
}

interface SavedPlace extends BookingPlace {
  savedAt: number;
}

/** Keeps where the client was, for the app to continue there after it is installed. */
export function saveBookingPlace(place: BookingPlace, now = Date.now()): void {
  try {
    const saved: SavedPlace = { ...place, savedAt: now };
    window.localStorage.setItem(RESUME_KEY, JSON.stringify(saved));
  } catch {
    // Blocked storage: the app starts from "My visits" as usual.
  }
}

/** The place saved less than RESUME_HOURS ago, if any. */
export function loadBookingPlace(now = Date.now()): BookingPlace | null {
  try {
    const raw = window.localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedPlace>;
    if (typeof value.slug !== 'string' || typeof value.salonName !== 'string') return null;
    if (typeof value.savedAt !== 'number' || now - value.savedAt > RESUME_HOURS * 3600_000) {
      return null;
    }
    if (!/^[a-z0-9-]{1,80}$/.test(value.slug)) return null;
    return {
      slug: value.slug,
      salonName: value.salonName.slice(0, 120),
      ...(typeof value.serviceId === 'string' ? { serviceId: value.serviceId } : {}),
      ...(typeof value.staffId === 'string' ? { staffId: value.staffId } : {}),
    };
  } catch {
    return null;
  }
}

/** Forgets the saved place (the client continued, or chose not to). */
export function clearBookingPlace(): void {
  try {
    window.localStorage.removeItem(RESUME_KEY);
  } catch {
    // Nothing to forget.
  }
}
