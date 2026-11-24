import type { BookingPreset } from './booking';
import { WEB_URL } from './config';

/**
 * Task Q2 (part 5): a link that opens the app at a salon — from the "Install the app" row on the
 * salon's booking page, the Android intent link, a QR code or a shared link.
 *
 *   beauty-client://b/{salon}?service=…&staff=…   the app's own scheme (app.json)
 *   https://…/{language}/b/{salon}?service=…      the salon's booking page (universal / app link)
 *   https://…/s/{salon}                           the salon's short link
 *   exp://…/--/b/{salon}                          the same paths in Expo Go while developing
 *
 * With a service the booking starts straight at the free times (the same `?service=&staff=` as
 * the web page, "Book again" and "Finish your booking"); with only a specialist (their QR code:
 * `?utm_source=qr&staff=…`) — at the services, and that specialist's times follow at once;
 * without either — the salon's page opens.
 * No React Native here — tested in Vitest (test/deepLink.test.ts).
 */

export interface DeepLink {
  slug: string;
  preset?: BookingPreset;
}

const SLUG = /^[a-z0-9-]{1,80}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGUAGE = /^[a-z]{2}$/;

function split(url: string): { path: string[]; query: URLSearchParams } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^?#]*)(\?[^#]*)?/i.exec(url.trim());
  if (!match) return null;
  const scheme = match[1]?.toLowerCase();
  const path = (match[2] ?? '').replace(/\/$/, '').split('/');
  if (scheme === 'http' || scheme === 'https') {
    const host = path.shift();
    if (!host) return null;
    try {
      const link = new URL(url.trim());
      const previewOrigin = typeof window === 'undefined' ? undefined : window.location?.origin;
      if (link.origin !== new URL(WEB_URL).origin && link.origin !== previewOrigin) return null;
    } catch {
      return null;
    }
  } else if (scheme === 'exp' || scheme === 'exps') {
    if (!path.shift()) return null;
    const marker = path.indexOf('--');
    if (marker >= 0) path.splice(0, marker + 1);
  } else if (scheme === 'beauty-client') {
    // Both beauty-client://b/salon and beauty-client:///b/salon name the app route.
    if (path[0] === '') path.shift();
  } else {
    return null;
  }
  try {
    return { path: path.map(decodeURIComponent), query: new URLSearchParams(match[3] ?? '') };
  } catch {
    return null;
  }
}

/** The salon (and service / specialist) a link points to, or null when it is not such a link. */
export function parseDeepLink(url: string | null | undefined): DeepLink | null {
  if (!url) return null;
  const parts = split(url);
  if (!parts) return null;
  const { path, query } = parts;
  let slug: string | undefined;
  if ((path[0] === 'b' || path[0] === 's') && path.length === 2) slug = path[1];
  else if (path.length === 3 && LANGUAGE.test(path[0] ?? '') && path[1] === 'b') slug = path[2];
  if (!slug) return null;
  slug = slug.toLowerCase();
  if (!SLUG.test(slug)) return null;
  const service = query.get('service') ?? '';
  const staff = query.get('staff') ?? '';
  if (!ID.test(service)) return ID.test(staff) ? { slug, preset: { staffId: staff } } : { slug };
  return { slug, preset: { serviceId: service, ...(ID.test(staff) ? { staffId: staff } : {}) } };
}
