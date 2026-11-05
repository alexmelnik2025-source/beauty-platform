/**
 * "Poleć salon" (task 151): the client sends a friend the salon's booking link. On a phone the
 * system share sheet opens; in the web preview the browser's share menu, or the link is copied.
 * No React Native here — the platform's share is passed in, so it is tested in Vitest
 * (test/share.test.ts).
 */

export interface ShareMessage {
  /** "GESTALT BARBERSHOP — umów się online: https://…" */
  message: string;
  url: string;
  title: string;
}

/** The text that goes with the link; {name} and {url} are filled in. */
export function shareMessage(template: string, name: string, url: string): ShareMessage {
  return {
    message: template.replace('{name}', name).replace('{url}', url),
    url,
    title: name,
  };
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
export async function shareSalon(content: ShareMessage, tools: ShareTools): Promise<ShareResult> {
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
      // The person closed the menu: nothing to say. Any other problem: copy the link instead.
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
