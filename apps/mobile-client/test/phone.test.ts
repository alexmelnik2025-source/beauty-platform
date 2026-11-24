import { describe, expect, it } from 'vitest';
import { checkContact } from '../src/booking';
import { dialForTimeZone, normalizePhone } from '../src/phone';

describe('booking and waitlist phone numbers', () => {
  it('uses the salon country and defaults to Poland for an unknown time zone', () => {
    expect(dialForTimeZone('Europe/Kyiv')).toBe('380');
    expect(dialForTimeZone('Europe/Kiev')).toBe('380');
    expect(dialForTimeZone('Unknown')).toBe('48');
  });

  it.each(['+48 123-45', '0048 12345678901234', '12345', '1234567890123456'])(
    'rejects an out-of-range phone number at booking: %s',
    (phone) => {
      expect(
        checkContact({
          name: 'Anna',
          email: 'anna@example.com',
          phone,
          acceptTerms: true,
          marketingConsent: false,
        }),
      ).toEqual({
        ok: false,
        problem: 'phone',
      });
    },
  );

  it.each([
    ['+48 600-100-200', '48', '+48600100200'],
    ['0048 600-100-200', '48', '+48600100200'],
    ['0049 151-2345-6789', '48', '+4915123456789'],
    ['(600) 100-200', '48', '+48600100200'],
    ['050 123 45 67', '380', '+380501234567'],
    ['06 12345678', '39', '+390612345678'],
    ['0044 7700 900123', '48', '+447700900123'],
    ['+48 600 100 200', '90', '+48600100200'],
    [' +380\u00a050\u00a0123 45 67 ', '48', '+380501234567'],
    [' +48\u202f600 100 200 ', '380', '+48600100200'],
    ['00 380 50 123 45 67', '48', '+380501234567'],
    ['1-23', '48', '123'],
    ['abc', '48', 'abc'],
  ])('normalizes %s with calling code %s', (value, dial, normalized) => {
    expect(normalizePhone(value, dial)).toBe(normalized);
  });
});
