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
