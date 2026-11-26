import { ApiError, type GiftVoucher } from './api';
import { dayTitle, formatPrice, type DayLocale } from './day';
import { errorText } from './errors';
import { fill, type Dictionary } from './i18n';

/** Task 492: the errors of "Bony podarunkowe" in the person's language; the rest as usual. */
export function voucherErrorText(error: unknown, t: Dictionary): string {
  if (error instanceof ApiError) {
    const v = t.vouchers;
    switch (error.code) {
      case 'VOUCHER_BALANCE':
        return v.errorBalance;
      case 'VOUCHER_EXPIRED':
        return v.errorExpired;
      case 'VOUCHER_CANCELLED':
        return v.errorCancelled;
      case 'VISIT_NOT_PAYABLE':
        return v.errorVisitNotPayable;
      case 'VOUCHER_DATE_PAST':
        return v.errorDatePast;
      case 'NOT_FOUND':
      case 'VALIDATION_ERROR':
        return v.notFound;
    }
  }
  return errorText(error, t);
}

/** "Ważny", "Wykorzystany"… */
export function voucherStatus(voucher: Pick<GiftVoucher, 'status'>, t: Dictionary): string {
  const v = t.vouchers;
  return {
    active: v.statusActive,
    used: v.statusUsed,
    expired: v.statusExpired,
    cancelled: v.statusCancelled,
  }[voucher.status];
}

/** "Zostało 80,00 zł z 200,00 zł · Ważny do piątek, 31 grudnia" (or "Bez terminu ważności"). */
export function voucherLine(
  voucher: Pick<GiftVoucher, 'balanceGrosze' | 'amountGrosze' | 'validUntil'>,
  t: Dictionary,
  currency: string,
  locale: DayLocale,
): string {
  const v = t.vouchers;
  const left = fill(v.left, {
    left: formatPrice(voucher.balanceGrosze, currency, locale),
    amount: formatPrice(voucher.amountGrosze, currency, locale),
  });
  const until = voucher.validUntil
    ? fill(v.validUntil, { date: dayTitle(voucher.validUntil, locale) })
    : v.noEnd;
  return `${left} · ${until}`;
}

/** Task 501: may be used now and ends by `until` (30 days from the salon's today, from the API). */
export function endsSoon(
  voucher: Pick<GiftVoucher, 'status' | 'validUntil'>,
  until: string,
): boolean {
  return voucher.status === 'active' && voucher.validUntil !== null && voucher.validUntil <= until;
}

/** "2026-12-31" or empty: what was typed in "Ważny do" (RRRR-MM-DD); undefined = not a day. */
export function parseValidUntil(text: string): string | null | undefined {
  const typed = text.trim();
  if (typed === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(typed)) return undefined;
  const [y, m, d] = typed.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? typed
    : undefined;
}

/** "ABCD-EFGH": easier to read and type; the dash does not matter when the code is checked. */
export function printedCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Task 497: "Wyślij bon" — the voucher as a message for the client (or whoever gives it):
 * the salon, the amount (what is left, once paid with), for whom, the code and the last day.
 * Task 539: `checkUrl` — while the salon page is public, the link where the client sees what is
 * left (`/b/<salon>?bon=<code>`).
 */
export function voucherText(
  voucher: Pick<
    GiftVoucher,
    'code' | 'amountGrosze' | 'balanceGrosze' | 'recipient' | 'validUntil'
  >,
  salonName: string,
  t: Dictionary,
  currency: string,
  locale: DayLocale,
  checkUrl?: string,
): string {
  const v = t.vouchers;
  return [
    fill(v.shareTitle, { salon: salonName }),
    // Part already paid with: what is left of how much.
    voucher.balanceGrosze === voucher.amountGrosze
      ? fill(v.shareAmount, { amount: formatPrice(voucher.amountGrosze, currency, locale) })
      : fill(v.left, {
          left: formatPrice(voucher.balanceGrosze, currency, locale),
          amount: formatPrice(voucher.amountGrosze, currency, locale),
        }),
    ...(voucher.recipient ? [fill(v.forWhom, { name: voucher.recipient })] : []),
    fill(v.shareCode, { code: printedCode(voucher.code) }),
    voucher.validUntil
      ? fill(v.validUntil, { date: dayTitle(voucher.validUntil, locale) })
      : v.noEnd,
    ...(checkUrl ? [fill(v.shareCheck, { url: checkUrl })] : []),
  ].join('\n');
}

/** Task 539: the salon page with the voucher code filled in — the client sees what is left. */
export function voucherCheckLink(bookingPage: string, code: string): string {
  return `${bookingPage}?bon=${encodeURIComponent(code)}`;
}

function voucherRemainder(toPayGrosze: number | null, paidGrosze: number): number | null {
  if (
    toPayGrosze === null ||
    !Number.isSafeInteger(toPayGrosze) ||
    !Number.isSafeInteger(paidGrosze) ||
    paidGrosze < 0
  )
    return null;
  return Math.max(0, toPayGrosze - paidGrosze);
}

/**
 * Task 545: what the client still pays for the visit after the gift vouchers (0 = the vouchers
 * covered it); null when there is nothing to say — no voucher payment or no visit price.
 */
export function visitVoucherLeft(toPayGrosze: number | null, paidGrosze: number): number | null {
  return paidGrosze === 0 ? null : voucherRemainder(toPayGrosze, paidGrosze);
}

/**
 * Task 542: what the amount field of "Zapłać bonem" in the visit card starts with — what is left to
 * pay for the visit ("90" or "49,50"); empty when the price is hidden or all is paid.
 */
export function visitVoucherAmount(toPayGrosze: number | null, paidGrosze: number): string {
  const left = voucherRemainder(toPayGrosze, paidGrosze);
  if (left === null || left === 0) return '';
  return left % 100 === 0 ? String(left / 100) : (left / 100).toFixed(2).replace('.', ',');
}
