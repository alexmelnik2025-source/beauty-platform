import { describe, expect, it } from 'vitest';
import type { SalonReport } from '../src/api';
import { tillOf } from '../src/till';

const report = (over: Partial<SalonReport['totals']>, extra: Partial<SalonReport> = {}) =>
  ({
    location: { id: 'l', name: 'Gestalt', timezone: 'Europe/Warsaw', currency: 'PLN' },
    from: '2026-11-06',
    to: '2026-11-06',
    scope: 'location',
    totals: { completed: 0, paid: 0, revenueGrosze: 0, ...over },
    payments: [],
    ...extra,
  }) as unknown as SalonReport;

describe('"Kasa dnia" (task 228)', () => {
  it('the paid visits by method and the ones that came but are not paid', () => {
    const till = tillOf(
      report(
        { completed: 3, paid: 2, revenueGrosze: 15000 },
        {
          payments: [
            { method: 'card', paid: 1, revenueGrosze: 9000 },
            { method: 'unknown', paid: 1, revenueGrosze: 6000 },
          ],
        },
      ),
      '2026-11-06',
    );
    expect(till).toEqual({
      revenueGrosze: 15000,
      currency: 'PLN',
      own: false,
      methods: [
        { method: 'card', paid: 1, revenueGrosze: 9000 },
        { method: 'unknown', paid: 1, revenueGrosze: 6000 },
      ],
      unpaid: 1,
    });
  });

  it('nothing before anyone came, for another day, or without a report', () => {
    expect(tillOf(report({}), '2026-11-06')).toBeNull();
    expect(tillOf(report({ completed: 1 }), '2026-11-07')).toBeNull();
    expect(tillOf(null, '2026-11-06')).toBeNull();
  });

  it("a specialist's own visits are marked as such", () => {
    const till = tillOf(report({ completed: 1 }, { scope: 'own' }), '2026-11-06');
    expect(till).toMatchObject({ own: true, unpaid: 1, revenueGrosze: 0 });
  });
});
