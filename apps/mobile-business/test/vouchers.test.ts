import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { pl } from '../src/locales/pl';
import {
  endsSoon,
  parseValidUntil,
  printedCode,
  visitVoucherAmount,
  voucherErrorText,
  voucherLine,
  voucherStatus,
  voucherCheckLink,
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

describe('"Sprawdź, ile zostało" in "Wyślij bon" (task 539)', () => {
  it('ends the message with the salon page that shows what is left', () => {
    const link = voucherCheckLink('https://example.com/pl/b/gestalt', 'ABCD2345');
    expect(link).toBe('https://example.com/pl/b/gestalt?bon=ABCD2345');
    expect(
      voucherText(
        {
          code: 'ABCD2345',
          amountGrosze: 5000,
          balanceGrosze: 5000,
          recipient: null,
          validUntil: null,
        },
        'Gestalt',
        pl,
        'PLN',
        'pl',
        link,
      )
        .split('\n')
        .at(-1),
    ).toBe('Sprawdź, ile zostało: https://example.com/pl/b/gestalt?bon=ABCD2345');
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

describe('"Wkrótce wygasa" (task 501)', () => {
  const until = '2026-12-19';
  it('marks the valid vouchers that end by the day the API gives', () => {
    expect(endsSoon({ status: 'active', validUntil: '2026-12-19' }, until)).toBe(true);
    expect(endsSoon({ status: 'active', validUntil: '2026-11-19' }, until)).toBe(true);
    expect(endsSoon({ status: 'active', validUntil: '2026-12-20' }, until)).toBe(false);
    expect(endsSoon({ status: 'active', validUntil: null }, until)).toBe(false);
    expect(endsSoon({ status: 'used', validUntil: '2026-12-01' }, until)).toBe(false);
    expect(endsSoon({ status: 'expired', validUntil: '2026-11-01' }, until)).toBe(false);
  });
});

describe('"Zapłać bonem" in the visit card (task 542)', () => {
  it('starts with what is left to pay for the visit', () => {
    expect(visitVoucherAmount(9000, 0)).toBe('90');
    expect(visitVoucherAmount(9000, 4050)).toBe('49,50');
    expect(visitVoucherAmount(9000, 9000)).toBe('');
    expect(visitVoucherAmount(9000, 10000)).toBe('');
    expect(visitVoucherAmount(null, 0)).toBe('');
  });

  it('writes the code as printed on the voucher', () => {
    expect(printedCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});
