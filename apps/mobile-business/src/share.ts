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

/**
 * What the QR code opens (task 354): the salon's short link marked as coming from the QR code —
 * the same link as the cabinet's "Kod QR", e.g. https://…/s/gestalt-barbershop?utm_source=qr.
 */
export function qrLink(webUrl: string, location: Pick<Location, 'slug'>): string {
  return `${webUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(location.slug)}?utm_source=qr`;
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

export type CsvShareResult = 'downloaded' | 'shared' | 'cancelled' | 'failed';

export interface CsvShareTools {
  /** In the browser (web preview): save the file (a Blob link). */
  download?: (fileName: string, csv: string) => void;
  /** On a phone: the share sheet with the file's text (mail, a messenger, notes). */
  native?: (content: { title: string; message: string }) => Promise<{ action: string }>;
}

/**
 * Task 220: "Pobierz CSV" in the business app. The browser saves the file; a phone shares its
 * text through the share sheet (saving a real file there would need extra Expo modules).
 */
export async function shareCsv(
  file: { fileName: string; csv: string },
  tools: CsvShareTools,
): Promise<CsvShareResult> {
  if (tools.download) {
    try {
      tools.download(file.fileName, file.csv);
      return 'downloaded';
    } catch {
      return 'failed';
    }
  }
  if (tools.native) {
    try {
      // The byte order mark is for spreadsheet programs opening a file, not for a message.
      const result = await tools.native({
        title: file.fileName,
        message: file.csv.replace(/^\uFEFF/, ''),
      });
      return result.action === 'dismissedAction' ? 'cancelled' : 'shared';
    } catch {
      return 'failed';
    }
  }
  return 'failed';
}

export interface TextShareTools {
  /** The phone's share sheet (React Native Share). */
  native?: (content: { title: string; message: string }) => Promise<{ action: string }>;
  /** The browser's share menu (navigator.share), when it has one. */
  webShare?: (data: { title: string; text: string }) => Promise<void>;
  /** Copy to the clipboard (navigator.clipboard.writeText). */
  copy?: (text: string) => Promise<void>;
}

/**
 * Task 351: shares a text (the day plan) — share sheet → browser menu → copying the text. The
 * same order as shareLink, but the whole text is copied, not a link.
 */
export async function shareText(
  content: { title: string; message: string },
  tools: TextShareTools,
): Promise<ShareResult> {
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
      await tools.webShare({ title: content.title, text: content.message });
      return 'shared';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    }
  }
  if (tools.copy) {
    try {
      await tools.copy(content.message);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
  return 'failed';
}
