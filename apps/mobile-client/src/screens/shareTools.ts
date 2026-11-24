import { Clipboard, Platform, Share } from 'react-native';
import type { ShareTools } from '../share';

/** What this platform can share with: the share sheet on phones, the browser's tools on the web. */
export function shareTools(): ShareTools {
  if (Platform.OS !== 'web') {
    // The link is in the message already (iOS would add `url` a second time).
    return {
      native:
        typeof Share?.share === 'function'
          ? (c) => Share.share({ message: c.message, title: c.title })
          : undefined,
      copy: async (text) => Clipboard.setString(text),
    };
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    webShare: typeof nav?.share === 'function' ? (data) => nav.share(data) : undefined,
    copy:
      typeof nav?.clipboard?.writeText === 'function'
        ? (text) => nav.clipboard.writeText(text)
        : undefined,
  };
}
