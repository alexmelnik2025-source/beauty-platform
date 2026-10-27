import { ApiError } from './api';

/** The API takes at most 3 MB; phone photos are often 5–12 MB, so they are made smaller here. */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
/** Longest side of a salon photo after shrinking: sharp on a laptop screen, ~200–500 KB. */
export const SALON_PHOTO_SIDE = 1600;
/** Staff portraits are shown small (avatar, staff picker). */
export const STAFF_PHOTO_SIDE = 800;
export const MAX_SALON_PHOTOS = 10;

/** Picker filter: what browsers can read. HEIC from iPhones is converted by iOS itself. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';

/**
 * Makes a picture from the phone or camera ready to upload: turned the right way up,
 * at most `maxSide` pixels on the longest side, JPEG on a white background (no
 * transparency), under 3 MB. Anything the browser cannot read is refused with the
 * same error the API would give.
 */
export async function shrinkPhoto(file: Blob, maxSide: number): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ApiError(415, 'UNSUPPORTED_PHOTO', 'The browser cannot read this picture');
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ApiError(415, 'UNSUPPORTED_PHOTO', 'No canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      );
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
    throw new ApiError(413, 'PHOTO_TOO_LARGE', 'Still too large after shrinking');
  } finally {
    bitmap.close();
  }
}
