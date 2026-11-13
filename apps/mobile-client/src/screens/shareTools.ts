import { Platform, Share } from 'react-native';
import type { ShareTools } from '../share';

/** What this platform can share with: the share sheet on phones, the browser's tools on the web. */
export function shareTools(): ShareTools {
  if (Platform.OS !== 'web') {
    // The link is in the message already (iOS would add `url` a second time).
    return { native: (c) => Share.share({ message: c.message, title: c.title }) };
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    webShare: nav?.share ? (data) => nav.share(data) : undefined,
    copy: nav?.clipboard ? (text) => nav.clipboard.writeText(text) : undefined,
  };
}
