/**
 * Task 431: the "W magazynie" field of a product — "" → null (the salon does not count the
 * pieces), "12" → 12; anything else (letters, a negative or a too big number) → undefined.
 */
export function parseStock(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  return /^\d{1,6}$/.test(text) && Number(text) <= 100_000 ? Number(text) : undefined;
}
