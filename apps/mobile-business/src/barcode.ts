import { ApiError } from './api';

/**
 * Task 522: "Kod kreskowy" — the code printed under the bars of a product's package. Like the
 * server: spaces dropped (a scanner or a person may add them), capital letters, 3–32 letters,
 * digits or "-".
 */

/** "" → null (not written), " 590 123 " → "590123"; a wrong code → undefined. */
export function parseBarcode(value: string): string | null | undefined {
  const code = value.replace(/\s+/g, '').toUpperCase();
  if (code === '') return null;
  return /^[0-9A-Z-]{3,32}$/.test(code) ? code : undefined;
}

/**
 * "Szukaj": a product matches by a piece of its name (any letter case) or of its barcode (spaces
 * ignored), so a code typed by a scanner finds the product at once. An empty search matches all.
 */
export function matchesProductSearch(
  product: { name: string; barcode: string | null },
  search: string,
): boolean {
  const text = search.trim().toLocaleLowerCase();
  if (text === '') return true;
  if (product.name.toLocaleLowerCase().includes(text)) return true;
  const code = text.replace(/\s+/g, '').toUpperCase();
  return product.barcode !== null && code !== '' && product.barcode.includes(code);
}

/** Another product of the salon already has this code (409 BARCODE_TAKEN). */
export const isBarcodeTaken = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'BARCODE_TAKEN';
