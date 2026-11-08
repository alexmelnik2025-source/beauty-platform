import { ApiError, type CustomerExport } from './api';
import type { Dictionary } from './i18n';
import { shareCsv, type CsvShareResult, type CsvShareTools } from './share';

/**
 * Task 334: "Dane osobowe (RODO)" in the client card of the business app — the salon owner
 * downloads everything kept about the client (a GDPR access request) or erases their data.
 * The same as the "Prywatność" part of the client card in the web cabinet (task 21); the
 * server allows it to owners only. No React Native here — tested in Vitest.
 */

/** The file's name, as the server names it: client-<id>.json. */
export function exportFileName(customerId: string): string {
  return `client-${customerId}.json`;
}

/** Readable JSON (indented), so the client can open it in any text editor. */
export function exportText(data: CustomerExport): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** The browser saves the .json file; a phone shares its text (mail, a messenger). */
export function shareExport(
  customerId: string,
  data: CustomerExport,
  tools: CsvShareTools,
): Promise<CsvShareResult> {
  return shareCsv({ fileName: exportFileName(customerId), csv: exportText(data) }, tools);
}

/** Why erasing was refused, in the person's language. */
export function eraseErrorText(error: unknown, t: Dictionary): string | null {
  if (!(error instanceof ApiError)) return null;
  const p = t.clientPrivacy;
  if (error.code === 'CUSTOMER_HAS_UPCOMING_VISITS') {
    const n = error.details.find((d) => d.path === 'upcoming')?.message;
    return n ? `${p.upcoming} (${n})` : p.upcoming;
  }
  if (error.code === 'CUSTOMER_ANONYMIZED') return p.already;
  if (error.code === 'VERSION_CONFLICT') return t.clients.conflict;
  if (error.status === 403) return p.ownerOnly;
  return null;
}
