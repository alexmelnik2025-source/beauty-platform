import { ApiError } from './api';
import type { Dictionary } from './i18n';

/** Code errors after which the client simply needs a fresh code. */
const NEW_CODE_NEEDED = ['CODE_EXPIRED', 'CODE_NOT_SENT', 'TOO_MANY_ATTEMPTS'];

/** A message the client understands, in their language. */
export function errorText(error: unknown, t: Dictionary): string {
  if (isNetworkError(error)) return t.error.network;
  if (error instanceof ApiError) {
    if (error.code && NEW_CODE_NEEDED.includes(error.code)) return t.signIn.newCodeNeeded;
    if (error.code === 'INVALID_CODE') return t.signIn.badCode;
    if (error.code === 'TOO_LATE_TO_CHANGE') return t.visit.tooLate;
    if (error.code === 'SLOT_TAKEN') return t.visit.slotTaken;
    if (error.code === 'NO_NEXT_VISIT') return t.visitProducts.noNextError;
    if (error.code?.startsWith('COUPON_')) return t.visit.couponNotAllowed;
    if (error.code === 'BOOKING_PHONE_ONLY') return t.error.bookByPhone;
    if (error.code === 'BOOKING_PAY_FIRST') return t.error.payFirst;
    if (error.code === 'TOO_MANY_FAVORITES') return t.favorites.tooMany;
    if (error.status === 429) return t.error.tooMany;
    if (error.status === 404) return t.error.notFound;
    return t.error.generic;
  }
  return t.error.network;
}

/** The first field named by the server that this form can correct. */
export function validationField<Field extends string>(
  error: unknown,
  fields: readonly Field[],
): Field | undefined {
  if (
    !(error instanceof ApiError) ||
    error.code !== 'VALIDATION_ERROR' ||
    !Array.isArray(error.details)
  ) {
    return undefined;
  }
  const details: unknown[] = error.details;
  return fields.find((field) =>
    details.some(
      (detail) =>
        typeof detail === 'object' && detail !== null && 'path' in detail && detail.path === field,
    ),
  );
}

export function isCodeError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ['INVALID_CODE', 'CODE_EXPIRED', 'CODE_NOT_SENT', 'TOO_MANY_ATTEMPTS'].includes(
      error.code ?? '',
    )
  );
}

export type FormFailure = { message: string; retry?: () => void };

export function formFailure(
  error: unknown,
  t: Dictionary,
  retry: () => void,
  message = errorText(error, t),
): FormFailure {
  return { message, ...(isNetworkError(error) ? { retry } : {}) };
}

export function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError && [408, 502, 503, 504].includes(error.status))
  );
}

export const wishFields = ['mood', 'drink', 'note'] as const;
export type WishField = (typeof wishFields)[number];
