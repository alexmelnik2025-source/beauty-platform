'use client';

/**
 * Installing the cabinet as an app (PWA) on a phone or computer.
 *
 * Chrome, Edge and Android fire `beforeinstallprompt`: we keep the event and show our own
 * "Install" button. iPhone and iPad have no such event: the person adds the app from Safari's
 * Share menu, so we show the steps instead.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let started = false;
const CHANGED = 'pwa-install-changed';

/** Registers the service worker and starts listening for the install event (once per page). */
export function startPwa(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    window.dispatchEvent(new Event(CHANGED));
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    window.dispatchEvent(new Event(CHANGED));
  });
}

export type InstallMode = 'installed' | 'prompt' | 'ios' | 'manual';

/** How this device can install the app right now. */
export function installMode(): InstallMode {
  if (typeof window === 'undefined') return 'manual';
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return 'installed';
  if (deferred) return 'prompt';
  const ua = navigator.userAgent;
  const ios =
    /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  return ios ? 'ios' : 'manual';
}

/** Shows the browser's install dialog. Returns true if the person agreed. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const event = deferred;
  deferred = null;
  await event.prompt();
  const choice = await event.userChoice;
  window.dispatchEvent(new Event(CHANGED));
  return choice.outcome === 'accepted';
}

/** Calls `listener` whenever the install possibility changes. Returns the unsubscribe function. */
export function onInstallChange(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
