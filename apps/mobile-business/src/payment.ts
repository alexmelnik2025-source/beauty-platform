import type { AppointmentDetail } from './api';

/** Task 227: how the client paid, in the order the picker shows them. */
export type PaymentMethod = NonNullable<AppointmentDetail['paymentMethod']>;
export const PAYMENT_METHODS = [
  'cash',
  'card',
  'blik',
  'transfer',
  'other',
] as const satisfies readonly PaymentMethod[];
// A new value on the server must be added above, or this line fails to compile.
const _everyMethod: Exclude<PaymentMethod, (typeof PAYMENT_METHODS)[number]> extends never
  ? true
  : never = true;
void _everyMethod;

/** A tap on the chosen method takes it off again ("not said"). */
export function toggleMethod(
  current: PaymentMethod | null,
  tapped: PaymentMethod,
): PaymentMethod | null {
  return current === tapped ? null : tapped;
}

/** The request body of "Opłacono" / "Cofnij opłatę"; a method only goes with a payment. */
export function paymentBody(
  version: number,
  paid: boolean,
  method?: PaymentMethod | null,
): { version: number; paid: boolean; method?: PaymentMethod | null } {
  return paid && method !== undefined ? { version, paid, method } : { version, paid };
}
