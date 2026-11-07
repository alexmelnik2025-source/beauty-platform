import type { TillClose } from './api';

/**
 * Task 232: "Zamknij kasę" — the cash counted in the till at the end of the day, beside what
 * the visits of that day paid in cash brought. No React Native imports, so it is tested with
 * Vitest (test/tillClose.test.ts).
 */
export type TillDifference =
  { kind: 'matches' } | { kind: 'missing'; grosze: number } | { kind: 'surplus'; grosze: number };

/** What the counted cash says: it matches, something is missing, or there is too much. */
export function tillDifference(close: NonNullable<TillClose['close']>): TillDifference {
  const diff = close.differenceGrosze;
  if (diff === 0) return { kind: 'matches' };
  return diff < 0 ? { kind: 'missing', grosze: -diff } : { kind: 'surplus', grosze: diff };
}

/** Cash payments changed after the till was counted (a visit paid or unpaid later). */
export function changedSinceClose(view: TillClose): boolean {
  return view.close !== null && view.close.expectedCashGrosze !== view.expectedCashGrosze;
}

/** 15000 → "150", 15050 → "150,50" — the counted amount back in the field. */
export function cashInput(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const cents = hundredths % 100;
  return cents === 0 ? String(whole) : `${whole},${String(cents).padStart(2, '0')}`;
}

/** "150", "150,5", "150.50" → hundredths; null when empty or not an amount. */
export function parseCash(text: string): number | null {
  const compact = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(compact)) return null;
  const value = Math.round(Number(compact) * 100);
  return value <= 100_000_000 ? value : null;
}

/** Task 235: "+10,00 zł" / "−10,00 zł" / "0,00 zł" — a difference with its sign. */
export function signed(hundredths: number, format: (positive: number) => string): string {
  return `${hundredths > 0 ? '+' : hundredths < 0 ? '−' : ''}${format(Math.abs(hundredths))}`;
}

/**
 * Task 236: what the form says should be in the till — with cash put in or taken out, the whole
 * sum and its parts; otherwise just what the cash visits brought.
 */
export function expectedParts(
  view: TillClose,
):
  | { kind: 'visits'; visits: number }
  | { kind: 'withMovements'; total: number; visits: number; cashIn: number; cashOut: number } {
  return view.movements.length === 0
    ? { kind: 'visits', visits: view.visitsCashGrosze }
    : {
        kind: 'withMovements',
        total: view.expectedCashGrosze,
        visits: view.visitsCashGrosze,
        cashIn: view.cashInGrosze,
        cashOut: view.cashOutGrosze,
      };
}

/** Task 236: a movement can be saved with an amount above zero and a reason. */
export function movementReady(amount: number | null, note: string): boolean {
  return amount !== null && amount > 0 && note.trim() !== '';
}
