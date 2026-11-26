import { describe, expect, it } from 'vitest';
import type { SalonReport } from '../src/api';
import { bonusToSave, EMPTY_BONUS } from '../src/bonusRules';
import { parseAdjustment } from '../src/clientBonus';
import { parsePercent } from '../src/commissions';
import { earnToSave } from '../src/earnRules';
import { paymentBody, toggleMethod } from '../src/payment';
import { change } from '../src/reports';
import { orderQuantity, parseDelivery, stocktakeCount } from '../src/stock';
import { tiersToSave } from '../src/tiers';
import { tillOf } from '../src/till';
import { parseCash } from '../src/tillClose';
import { parseTip } from '../src/tip';
import { couponCode } from '../src/visitCoupons';
import { visitVoucherAmount, visitVoucherLeft } from '../src/vouchers';

describe('cash and tips in whole grosze', () => {
  it('preserves every last grosz below a large whole amount', () => {
    for (let cents = 0; cents < 100; cents++) {
      const fraction = String(cents).padStart(2, '0');
      const expected = 9_999_900 + cents;
      expect(parseCash(`99 999,${fraction}`)).toBe(expected);
      expect(parseTip(`99999.${fraction}`)).toBe(expected);
    }
  });

  it('distinguishes an empty count from no tip, and enforces the separate limits', () => {
    expect(parseCash(' \u00a0 ')).toBeNull();
    expect(parseTip(' \u00a0 ')).toBe(0);
    expect(parseCash('100000.01')).toBe(10_000_001);
    expect(parseTip('100000.01')).toBeNull();
  });

  it.each(['NaN', '-0,01', '1e7', '0.005', '9007199254740993'])(
    'rejects %j instead of treating it as an amount',
    (text) => {
      expect(parseCash(text)).toBeNull();
      expect(parseTip(text)).toBeNull();
    },
  );

  it('keeps tips separate when a free visit and paid visits use different methods', () => {
    const date = '2026-10-25';
    const payments: SalonReport['payments'] = [
      { method: 'card', paid: 1, revenueGrosze: 0 },
      { method: 'cash', paid: 1, revenueGrosze: 1 },
      { method: 'blik', paid: 1, revenueGrosze: 99_999_999 },
    ];
    const report: Pick<
      SalonReport,
      'from' | 'to' | 'scope' | 'location' | 'totals' | 'tips' | 'payments'
    > = {
      from: date,
      to: date,
      scope: 'location',
      location: { id: 'salon', name: 'Salon', currency: 'PLN', timezone: 'Europe/Warsaw' },
      totals: {
        visits: 4,
        upcoming: 0,
        paid: 3,
        completed: 4,
        noShow: 0,
        cancelledByClient: 0,
        cancelledBySalon: 0,
        clients: 4,
        newClients: 0,
        online: 0,
        revenueGrosze: 100_000_000,
        averageTicketGrosze: 33_333_333,
        discountGrosze: 0,
      },
      tips: { totalGrosze: 125, visits: 1, staff: [] },
      payments,
    };
    expect(tillOf(report as SalonReport, date)).toStrictEqual({
      revenueGrosze: 100_000_000,
      currency: 'PLN',
      own: false,
      unpaid: 1,
      methods: payments,
      tipsGrosze: 125,
    });
  });
});

describe('paying a discounted visit', () => {
  it('sends only the last selected method, including an explicit removal', () => {
    const first = toggleMethod(null, 'card');
    const second = toggleMethod(first, 'blik');
    expect(paymentBody(4, true, second)).toStrictEqual({ version: 4, paid: true, method: 'blik' });
    expect(paymentBody(5, true, toggleMethod(second, 'blik'))).toStrictEqual({
      version: 5,
      paid: true,
      method: null,
    });
  });

  it('never asks for another grosz when the discount exceeds the visit price', () => {
    const price = 4999;
    const discount = 5000;
    expect(visitVoucherAmount(price - discount, 0)).toBe('');
    expect(visitVoucherAmount(price - discount, 1)).toBe('');
    expect(visitVoucherLeft(price - discount, 1)).toBe(0);
  });

  it('can collect the last grosz even after a large voucher payment', () => {
    expect(visitVoucherLeft(100_000_000, 99_999_999)).toBe(1);
    expect(visitVoucherAmount(100_000_000, 99_999_999)).toBe('0,01');
    expect(visitVoucherLeft(null, 99_999_999)).toBeNull();
    expect(visitVoucherAmount(null, 99_999_999)).toBe('');
  });

  it.each([
    [5000, -1],
    [5000, NaN],
    [NaN, 1],
    [5000, 0.5],
  ])('omits the balance and payment suggestion for malformed amounts (%s, %s)', (due, paid) => {
    expect(visitVoucherLeft(due, paid)).toBeNull();
    expect(visitVoucherAmount(due, paid)).toBe('');
  });

  it('checks both coupon-code limits after removing pasted whitespace', () => {
    const longest = 'abcd '.repeat(5);
    expect(couponCode(longest)).toBe('ABCD'.repeat(5));
    expect(couponCode(longest + 'x')).toBeNull();
    expect(couponCode(' a b c d ')).toBe('ABCD');
    expect(couponCode(' a b c ')).toBeNull();
  });
});

describe('commissions, tier discounts and loyalty points', () => {
  it('accepts tenths of a percent for commissions and whole percentages for tier discounts', () => {
    const row = { name: 'Gold', threshold: '1,15', discountPercent: '99,9' };
    expect(parsePercent(row.discountPercent)).toBe(99.9);
    expect(tiersToSave('spend', '30', [row])).toEqual({ ok: false, problem: 'discount', row: 0 });
    expect(tiersToSave('spend', '30', [{ ...row, discountPercent: '100' }])).toEqual({
      ok: true,
      save: {
        basis: 'spend',
        periodDays: 30,
        tiers: [{ name: 'Gold', threshold: 115, discountPercent: 100 }],
      },
    });
  });

  it('reports an ineffective bonus when both optional amounts are blank', () => {
    const rule = { ...EMPTY_BONUS, name: 'Extra', multiplier: ' ', extraPoints: ' ' };
    expect(bonusToSave([rule])).toEqual({ ok: false, problem: 'nothing', row: 0 });
    expect(bonusToSave([{ ...rule, extraPoints: '1', withinDays: '365' }])).toMatchObject({
      ok: true,
      save: { rules: [{ multiplier: 1, extraPoints: 1, withinDays: 365 }] },
    });
  });

  it('keeps zero-point and maximum overrides when another service inherits the default', () => {
    const services = [
      { id: 'cut', name: 'Cut' },
      { id: 'wash', name: 'Wash' },
      { id: 'colour', name: 'Colour' },
    ];
    const amounts = { cut: ' ', wash: '000000', colour: '100000' };
    expect(earnToSave(amounts, services)).toEqual({
      ok: true,
      save: {
        rules: [
          { serviceId: 'wash', points: 0 },
          { serviceId: 'colour', points: 100_000 },
        ],
      },
    });
    expect(earnToSave({ ...amounts, colour: 'NaN' }, services)).toEqual({
      ok: false,
      service: 'Colour',
    });
  });

  it('accepts a maximum debit with a trimmed 500-character reason', () => {
    const reason = 'a'.repeat(500);
    expect(parseAdjustment('−100000', ` ${reason} `)).toEqual({
      ok: true,
      points: -100_000,
      reason,
    });
    expect(parseAdjustment('−100000', reason + 'b')).toEqual({ ok: false, problem: 'reason' });
  });
});

describe('report comparisons and deliveries', () => {
  it('compares large sums on either side of the whole-percent rounding boundary', () => {
    expect(change(100_499_999, 100_000_000)).toBeNull();
    expect(change(100_500_000, 100_000_000)).toBe('+1%');
    expect(change(99_499_999, 100_000_000)).toBe('−1%');
  });

  it.each([
    [NaN, 100],
    [100, NaN],
    [Infinity, 100],
    [100, Infinity],
    [Number.MAX_VALUE, 1],
  ])(
    'omits a comparison that cannot be expressed as a finite percentage (%s, %s)',
    (current, previous) => expect(change(current, previous)).toBeNull(),
  );

  it('offers a valid delivery up to 100000 units and distinguishes a zero stocktake from a delivery', () => {
    const units = orderQuantity({ stockQuantity: 0, lowStockAt: 99_999 }, 0);
    expect(units).toBe(100_000);
    expect(parseDelivery(String(units))).toBe(100_000);
    expect(stocktakeCount('0', 100_000)).toBe(0);
    expect(parseDelivery('0')).toBeUndefined();
    expect(parseDelivery('')).toBeNull();
  });
});
