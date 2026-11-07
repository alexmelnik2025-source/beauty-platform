import { describe, expect, it } from 'vitest';
import { newAppointmentBody } from '../src/newVisit';
import { PAYMENT_METHODS, paymentBody, toggleMethod } from '../src/payment';
import { DICTIONARIES, LOCALES } from '../src/i18n';

describe('payment method (task 227)', () => {
  it('a tap picks a method, a tap on the chosen one takes it off', () => {
    expect(toggleMethod(null, 'card')).toBe('card');
    expect(toggleMethod('card', 'cash')).toBe('cash');
    expect(toggleMethod('cash', 'cash')).toBeNull();
  });

  it('a method goes only with a payment; null clears it on a paid visit', () => {
    expect(paymentBody(3, true, 'blik')).toEqual({ version: 3, paid: true, method: 'blik' });
    expect(paymentBody(3, true, null)).toEqual({ version: 3, paid: true, method: null });
    expect(paymentBody(3, true)).toEqual({ version: 3, paid: true });
    expect(paymentBody(3, false, 'cash')).toEqual({ version: 3, paid: false });
  });

  it('a walk-in entered as paid carries how it was paid', () => {
    const base = {
      serviceId: 's',
      staffId: 'p',
      start: '2026-11-07T10:00:00.000Z',
      client: { id: 'c' },
      locale: 'pl' as const,
      note: '',
    };
    expect(newAppointmentBody({ ...base, walkIn: { paid: true, method: 'card' } })).toMatchObject({
      alreadyHappened: true,
      paid: true,
      paymentMethod: 'card',
    });
    const unpaid = newAppointmentBody({ ...base, walkIn: { paid: false, method: 'card' } });
    expect(unpaid).not.toHaveProperty('paymentMethod');
    expect(unpaid).not.toHaveProperty('paid');
  });

  it('every method has a name in every language', () => {
    for (const locale of LOCALES) {
      for (const method of PAYMENT_METHODS) {
        expect(
          DICTIONARIES[locale].visit.paymentMethods[method],
          `${locale}.${method}`,
        ).toBeTruthy();
      }
    }
  });
});
