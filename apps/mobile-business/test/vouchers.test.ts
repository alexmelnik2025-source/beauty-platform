import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { pl } from '../src/locales/pl';
import { parseValidUntil, voucherErrorText, voucherLine, voucherStatus } from '../src/vouchers';

const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('gift vouchers in the business app (task 492)', () => {
  it('says what is left and until when', () => {
    expect(
      nbsp(
        voucherLine(
          { balanceGrosze: 8000, amountGrosze: 20000, validUntil: '2026-12-31' },
          pl,
          'PLN',
          'pl',
        ),
      ),
    ).toBe('Zostało 80,00 zł z 200,00 zł · Ważny do czwartek, 31 grudnia');
    expect(
      nbsp(
        voucherLine({ balanceGrosze: 0, amountGrosze: 5000, validUntil: null }, pl, 'PLN', 'pl'),
      ),
    ).toBe('Zostało 0,00 zł z 50,00 zł · Bez terminu ważności');
  });

  it('names the status', () => {
    expect(voucherStatus({ status: 'active' }, pl)).toBe('Ważny');
    expect(voucherStatus({ status: 'cancelled' }, pl)).toBe('Anulowany');
  });

  it('explains the voucher errors', () => {
    expect(voucherErrorText(new ApiError(409, 'x', 'VOUCHER_BALANCE'), pl)).toBe(
      pl.vouchers.errorBalance,
    );
    expect(voucherErrorText(new ApiError(404, 'x', 'NOT_FOUND'), pl)).toBe(pl.vouchers.notFound);
    expect(voucherErrorText(new ApiError(500, 'x', 'INTERNAL'), pl)).toBe(pl.error.generic);
  });

  it('reads the last day', () => {
    expect(parseValidUntil('')).toBeNull();
    expect(parseValidUntil(' 2026-12-31 ')).toBe('2026-12-31');
    expect(parseValidUntil('2026-02-30')).toBeUndefined();
    expect(parseValidUntil('31.12.2026')).toBeUndefined();
  });
});
