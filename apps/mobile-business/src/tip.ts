/**
 * Task 229: the tip the client left on a visit that took place — only a note for the report
 * and "Kasa dnia", not part of the price. The field takes "15", "15,5", "15.50"; empty = none.
 */

/** 1500 → "15", 1550 → "15,50", 0 → "" — for the field. */
export function tipInput(hundredths: number): string {
  if (hundredths === 0) return '';
  const whole = Math.floor(hundredths / 100);
  const cents = hundredths % 100;
  return cents === 0 ? String(whole) : `${whole},${String(cents).padStart(2, '0')}`;
}

/** Hundredths (an empty field = 0, no tip); null when it is not an amount the server takes. */
export function parseTip(text: string): number | null {
  const compact = text.replace(/\s/g, '').replace(',', '.');
  if (compact === '') return 0;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(compact)) return null;
  const value = Math.round(Number(compact) * 100);
  return value <= 10_000_000 ? value : null;
}
