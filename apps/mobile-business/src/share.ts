import type { Location } from './api';

/**
 * "Link do rezerwacji" in the business app (task 152): the owner or a manager sends the salon's
 * booking link (Instagram bio, WhatsApp, a text message). On a phone the system share sheet
 * opens (it has "Copy" too); in the web preview the browser's share menu, or the link is
 * copied. No React Native here — the platform's share is passed in, so it is tested in Vitest
 * (test/share.test.ts). The same rules as apps/mobile-client/src/share.ts.
 */

/** The salon's booking page in its own language, e.g. https://…/pl/b/gestalt-barbershop. */
export function bookingLink(
  webUrl: string,
  location: Pick<Location, 'slug' | 'defaultLocale'>,
): string {
  return `${webUrl.replace(/\/+$/, '')}/${location.defaultLocale}/b/${encodeURIComponent(location.slug)}`;
}

export interface ShareMessage {
  message: string;
  url: string;
  title: string;
}

export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

export interface ShareTools {
  /** The phone's share sheet (React Native Share). */
  native?: (content: ShareMessage) => Promise<{ action: string }>;
  /** The browser's share menu (navigator.share), when it has one. */
  webShare?: (data: { title: string; text: string; url: string }) => Promise<void>;
  /** Copy to the clipboard (navigator.clipboard.writeText). */
  copy?: (text: string) => Promise<void>;
}

/** Shares with what the platform has: share sheet → browser menu → copying the link. */
export async function shareLink(content: ShareMessage, tools: ShareTools): Promise<ShareResult> {
  if (tools.native) {
    try {
      const result = await tools.native(content);
      return result.action === 'dismissedAction' ? 'cancelled' : 'shared';
    } catch {
      return 'failed';
    }
  }
  if (tools.webShare) {
    try {
      await tools.webShare({ title: content.title, text: content.message, url: content.url });
      return 'shared';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    }
  }
  if (tools.copy) {
    try {
      await tools.copy(content.url);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
  return 'failed';
}
