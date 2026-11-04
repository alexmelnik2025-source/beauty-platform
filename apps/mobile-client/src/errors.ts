import { ApiError } from './api';
import type { Dictionary } from './i18n';

/** Code errors after which the client simply needs a fresh code. */
const NEW_CODE_NEEDED = ['CODE_EXPIRED', 'CODE_NOT_SENT', 'TOO_MANY_ATTEMPTS'];

/** A message the client understands, in their language. */
export function errorText(error: unknown, t: Dictionary): string {
  if (error instanceof ApiError) {
    if (error.code && NEW_CODE_NEEDED.includes(error.code)) return t.signIn.newCodeNeeded;
    if (error.code === 'INVALID_CODE') return t.signIn.badCode;
    if (error.code === 'TOO_LATE_TO_CHANGE') return t.visit.tooLate;
    if (error.code === 'SLOT_TAKEN') return t.visit.slotTaken;
    if (error.status === 429) return t.error.tooMany;
    if (error.status === 404) return t.error.notFound;
    return t.error.generic;
  }
  return t.error.network;
}
