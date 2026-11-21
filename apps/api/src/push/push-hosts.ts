/**
 * Push services of the browsers our apps run in. A subscription is an address the server
 * POSTs to, so only these hosts are accepted: an address inside our network (or anyone
 * else's server) is never called on a user's say-so.
 *
 * Chrome, Edge (Chromium), Opera, Samsung Internet, Brave: Firebase Cloud Messaging.
 * Firefox: Mozilla autopush. Safari (macOS, iOS 16.4+ home-screen apps): Apple.
 * Old Edge / Windows: WNS.
 */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

/** Hosts under these domains (for example `wns2-par02p.notify.windows.com`). */
const HOST_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

/** Whether `endpoint` is an https address at a known browser push service. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
