'use client';

import type { PushPublicKey } from './types';

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

// ── Push notifications (Web Push) ─────────────────────────

export type PushState =
  /** This browser cannot receive push at all. */
  | 'unsupported'
  /** iPhone/iPad: push works only in the app added to the home screen. */
  | 'needs-install'
  /** The server has no push keys (push is off on this installation). */
  | 'server-off'
  /** The person blocked notifications for this site in the browser settings. */
  | 'denied'
  | 'on'
  | 'off';

/** The VAPID key from base64url to the bytes the browser wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/** Whether push is on for this device. */
export async function pushState(
  api: <T>(path: string, options?: { method?: 'POST'; body?: unknown }) => Promise<T>,
): Promise<PushState> {
  if (!pushSupported()) return installMode() === 'ios' ? 'needs-install' : 'unsupported';
  const { publicKey } = await api<PushPublicKey>('/v1/me/push-subscriptions/public-key');
  if (!publicKey) return 'server-off';
  if (Notification.permission === 'denied') return 'denied';
  const subscription = await currentSubscription();
  if (!subscription) return 'off';
  // Tell the server again: the device may now be signed in as someone else.
  await api('/v1/me/push-subscriptions', { method: 'POST', body: subscription.toJSON() });
  return 'on';
}

/** Asks for permission and turns push on for this device. */
export async function enablePush(
  api: <T>(path: string, options?: { method?: 'POST'; body?: unknown }) => Promise<T>,
): Promise<PushState> {
  if (!pushSupported()) return installMode() === 'ios' ? 'needs-install' : 'unsupported';
  const { publicKey } = await api<PushPublicKey>('/v1/me/push-subscriptions/public-key');
  if (!publicKey) return 'server-off';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  await api('/v1/me/push-subscriptions', { method: 'POST', body: subscription.toJSON() });
  return 'on';
}

/** Turns push off for this device. */
export async function disablePush(
  api: <T>(path: string, options?: { method?: 'POST'; body?: unknown }) => Promise<T>,
): Promise<PushState> {
  const subscription = pushSupported() ? await currentSubscription() : null;
  if (subscription) {
    await api('/v1/me/push-subscriptions/remove', {
      method: 'POST',
      body: { endpoint: subscription.endpoint },
    });
    await subscription.unsubscribe();
  }
  return 'off';
}
