import { ApiError } from './api';
import type { Dictionary } from './i18n';

/** A message the person understands, in their language. */
export function errorText(error: unknown, t: Dictionary): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return t.error.tooMany;
    return t.error.generic;
  }
  return t.error.network;
}
