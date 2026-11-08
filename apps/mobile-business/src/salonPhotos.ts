import { ApiError } from './api';
import type { Dictionary } from './i18n';

/**
 * Task 337: "Dodaj zdjęcie" in "Zdjęcia salonu" of the business app — photos from the phone's
 * gallery go to the booking page. No React Native here — tested in Vitest
 * (test/salonPhotos.test.ts). The server checks the type, the size and the number again.
 */

/** As many photos as the server keeps for one salon (MAX_SALON_PHOTOS in the API). */
export const MAX_SALON_PHOTOS = 10;

/** The picture types the API takes. */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The type a picked photo is sent as: its own when the API takes it, otherwise JPEG (the
 * phone's picker converts other formats, such as HEIC from an iPhone, to JPEG). The same as in
 * the client app (apps/mobile-client/src/wishes.ts).
 */
export function photoType(mimeType: string | null | undefined, blobType: string): string {
  const type = (mimeType || blobType || '').toLowerCase();
  return PHOTO_TYPES.includes(type) ? type : 'image/jpeg';
}

/** How many more photos can be added now (0 = the gallery is full). */
export function photosLeft(count: number): number {
  return Math.max(0, MAX_SALON_PHOTOS - count);
}

/** Why a photo was not added, in the person's language; null — the usual error text. */
export function uploadErrorText(error: unknown, t: Dictionary): string | null {
  if (!(error instanceof ApiError)) return null;
  const s = t.salon;
  if (error.code === 'TOO_MANY_PHOTOS') return s.photosFull;
  if (error.code === 'PHOTO_TOO_LARGE') return s.photoTooLarge;
  if (error.code === 'UNSUPPORTED_PHOTO') return s.photoBadType;
  return null;
}
