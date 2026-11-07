import { describe, expect, it } from 'vitest';
import { parseTip, tipInput } from '../src/tip';
import { tillOf } from '../src/till';
import type { SalonReport } from '../src/api';

describe('tip field (task 229)', () => {
  it('reads amounts with a comma or a point; empty is no tip', () => {
    expect(parseTip('15')).toBe(1500);
    expect(parseTip('15,5')).toBe(1550);
    expect(parseTip(' 15.50 ')).toBe(1550);
    expect(parseTip('')).toBe(0);
    expect(parseTip('0')).toBe(0);
  });

  it('refuses what is not an amount the server takes', () => {
    for (const text of ['-5', '15,555', 'abc', '1e3', '15,5x', '100001']) {
      expect(parseTip(text)).toBeNull();
    }
    expect(parseTip('100000')).toBe(10_000_000);
  });

  it('shows the saved tip back in the field', () => {
    expect(tipInput(0)).toBe('');
    expect(tipInput(1500)).toBe('15');
    expect(tipInput(1505)).toBe('15,05');
    expect(parseTip(tipInput(1505))).toBe(1505);
  });

  it('"Kasa dnia" carries the day\'s tips apart from the visit money', () => {
    const report = {
      location: { id: 'l', name: 'GESTALT', timezone: 'Europe/Warsaw', currency: 'PLN' },
      from: '2026-11-06',
      to: '2026-11-06',
      scope: 'location',
      totals: { completed: 1, paid: 1, revenueGrosze: 9000 },
      payments: [{ method: 'cash', paid: 1, revenueGrosze: 9000 }],
      tips: { totalGrosze: 1550, visits: 1, staff: [] },
    } as unknown as SalonReport;
    expect(tillOf(report, '2026-11-06')).toMatchObject({ revenueGrosze: 9000, tipsGrosze: 1550 });
  });
});
