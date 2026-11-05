import { Platform, Share } from 'react-native';

/** The little of the browser's document used here (the app's types are React Native's). */
interface BrowserDocument {
  createElement(tag: 'a'): { href: string; download: string; click(): void; remove(): void };
  body: { append(node: unknown): void };
}

/**
 * Task 97 — hands the "Download my data" file to the client. In the browser (the web version of
 * the app) the JSON file downloads, as on the site; on a phone the system share sheet opens with
 * the data, so the client saves it to Files / Drive or sends it by email — no extra native module.
 */
export async function saveMyData(json: string, fileName: string, title: string): Promise<void> {
  if (Platform.OS === 'web') {
    const doc = (globalThis as unknown as { document: BrowserDocument }).document;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = fileName;
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  await Share.share({ title, message: json }, { subject: fileName, dialogTitle: title });
}
