import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { pl } from '../src/locales/pl';
import {
  parseValidUntil,
  voucherErrorText,
  voucherLine,
  voucherStatus,
  voucherText,
} from '../src/vouchers';

const nbsp = (s: string) => s.replace(/\s/g, ' ');

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

describe('"Wyślij bon" (task 497)', () => {
  it('writes the voucher as a message: salon, amount, for whom, code, last day', () => {
    expect(
      nbsp(
        voucherText(
          {
            code: 'ABCD2345',
            amountGrosze: 20000,
            balanceGrosze: 20000,
            recipient: 'Jan',
            validUntil: '2026-12-31',
          },
          'Gestalt Barbershop',
          pl,
          'PLN',
          'pl',
        ),
      ),
    ).toBe(
      'Bon podarunkowy — Gestalt Barbershop Kwota: 200,00 zł Dla: Jan Kod: ABCD-2345 Ważny do czwartek, 31 grudnia',
    );
    expect(
      voucherText(
        {
          code: 'ABCD2345',
          amountGrosze: 5000,
          balanceGrosze: 2000,
          recipient: null,
          validUntil: null,
        },
        'Gestalt',
        pl,
        'PLN',
        'pl',
      ).split('\n'),
    ).toEqual([
      'Bon podarunkowy — Gestalt',
      'Zostało 20,00\u00a0zł z 50,00\u00a0zł',
      'Kod: ABCD-2345',
      'Bez terminu ważności',
    ]);
  });
});
