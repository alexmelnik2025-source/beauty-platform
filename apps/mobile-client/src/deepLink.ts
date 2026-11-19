import type { BookingPreset } from './booking';

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
 * the web page, "Book again" and "Finish your booking"); without — the salon's page opens.
 * No React Native here — tested in Vitest (test/deepLink.test.ts).
 */

export interface DeepLink {
  slug: string;
  preset?: BookingPreset;
}

const SLUG = /^[a-z0-9-]{1,80}$/;
const ID = /^[0-9a-f-]{36}$/i;
const LANGUAGE = /^[a-z]{2}$/;

/** Schemes with a host before the path; the app's own scheme starts with the path right away. */
const WITH_HOST = /^(https?|exps?):$/i;

/** The path and query of a link, whatever its scheme (URL in the app may not parse custom schemes). */
function split(url: string): { path: string[]; query: URLSearchParams } | null {
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^?#]*)(\?[^#]*)?/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1] ?? '';
  let path = (m[2] ?? '').split('/').filter(Boolean).map(safeDecode);
  if (WITH_HOST.test(scheme)) path = path.slice(1);
  // Expo Go: exp://host/--/b/salon
  const marker = path.indexOf('--');
  if (marker >= 0) path = path.slice(marker + 1);
  return { path, query: new URLSearchParams(m[3] ?? '') };
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
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
  if (!ID.test(service)) return { slug };
  return { slug, preset: { serviceId: service, ...(ID.test(staff) ? { staffId: staff } : {}) } };
}
