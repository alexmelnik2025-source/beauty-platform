import { readFile } from 'node:fs/promises';

/**
 * Without an SMS gateway the API runs with SMS_TRANSPORT=log (development only): the text
 * of each SMS goes to the API log. CI writes it to api.log in the repository root.
 */
const API_LOG = process.env.API_LOG ?? '../../api.log';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Waits for an SMS to `phone` (E.164) in the API log; returns the 6-digit code from it. */
export async function waitForSmsCode(phone: string, timeoutMs = 20_000): Promise<string> {
  const escaped = phone.replace(/[+]/g, '\\+');
  const pattern = new RegExp(`SMS to ${escaped}: (\\d{6})`, 'g');
  const until = Date.now() + timeoutMs;
  for (;;) {
    const log = (await readFile(API_LOG, 'utf8').catch(() => '')).replace(ANSI, '');
    const codes = [...log.matchAll(pattern)].map((m) => m[1]!);
    if (codes.length > 0) return codes[codes.length - 1]!;
    if (Date.now() > until) throw new Error(`No SMS to ${phone} in ${API_LOG}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
