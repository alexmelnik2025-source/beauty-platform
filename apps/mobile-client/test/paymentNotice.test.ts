import { describe, expect, it } from 'vitest';
import { paymentNoticeAmount } from '../src/paymentNotice';

const details = (amount: unknown, currency: unknown) => [
  { path: 'amountGrosze', message: amount },
  { path: 'currency', message: currency },
];

describe('booking payment notice', () => {
  it('reads a disclosed amount in minor currency units', () => {
    expect(paymentNoticeAmount([null, ...details('5500', 'PLN')])).toEqual({
      value: 5500,
      currency: 'PLN',
    });
    expect(paymentNoticeAmount(details('0', 'EUR'))).toEqual({ value: 0, currency: 'EUR' });
  });

  it.each(['0', '5500'])('omits the amount %s when no currency was disclosed', (amount) => {
    expect(paymentNoticeAmount([{ path: 'amountGrosze', message: amount }])).toBeNull();
    expect(paymentNoticeAmount(details(amount, ''))).toBeNull();
  });

  it('omits unpublished or malformed amounts', () => {
    for (const value of [
      undefined,
      {},
      [],
      details(100, 'PLN'),
      details('-1', 'PLN'),
      details('1.5', 'PLN'),
      details('9007199254740992', 'PLN'),
      details('100', 'pln'),
    ])
      expect(paymentNoticeAmount(value)).toBeNull();
  });
});
