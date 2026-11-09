import { describe, expect, it } from 'vitest';
import {
  change,
  dayBars,
  onlineShare,
  peakHours,
  reportRange,
  shortDay,
  starsText,
  weekdayLong,
} from '../src/reports';

describe('report periods', () => {
  it('this month, last month (also across a year) and the last 30 days', () => {
    expect(reportRange('thisMonth', '2026-11-04')).toEqual({
      from: '2026-11-01',
      to: '2026-11-04',
    });
    expect(reportRange('lastMonth', '2026-11-04')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(reportRange('lastMonth', '2027-01-15')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(reportRange('lastMonth', '2028-03-01')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(reportRange('last30', '2026-11-04')).toEqual({ from: '2026-10-06', to: '2026-11-04' });
  });

  it('online share leaves cancelled visits out', () => {
    expect(onlineShare({ visits: 10, online: 3, cancelledByClient: 2, cancelledBySalon: 2 })).toBe(
      50,
    );
    expect(onlineShare({ visits: 1, online: 0, cancelledByClient: 1, cancelledBySalon: 0 })).toBe(
      0,
    );
  });

  it('change against the days before, and weekday names', () => {
    expect(change(112, 100)).toBe('+12%');
    expect(change(95, 100)).toBe('−5%');
    expect(change(100, 100)).toBeNull();
    expect(change(10, 0)).toBeNull();
    expect(weekdayLong(1, 'pl')).toBe('poniedziałek');
    expect(weekdayLong(7, 'en')).toBe('Sunday');
  });
});

describe('average stars (task 213)', () => {
  it('one decimal in the app language', () => {
    expect(starsText(4.5, 'pl')).toBe('4,5');
    expect(starsText(5, 'pl')).toBe('5,0');
    expect(starsText(4.7, 'en')).toBe('4.7');
  });
});

describe('peak hours (task 216)', () => {
  it('most visits first, ties earlier in the week and the day', () => {
    const cells = [
      { weekday: 1, hour: 9, visits: 1 },
      { weekday: 5, hour: 17, visits: 6 },
      { weekday: 6, hour: 10, visits: 4 },
      { weekday: 2, hour: 18, visits: 4 },
      { weekday: 2, hour: 12, visits: 4 },
    ];
    expect(peakHours(cells)).toEqual([
      { weekday: 5, hour: 17, visits: 6 },
      { weekday: 2, hour: 12, visits: 4 },
      { weekday: 2, hour: 18, visits: 4 },
    ]);
    expect(peakHours([])).toEqual([]);
  });
});

describe('"Dzień po dniu" (task 356)', () => {
  it('scales bars to the best day and marks it', () => {
    const bars = dayBars([
      { date: '2026-11-02', completed: 3, revenueGrosze: 30000 },
      { date: '2026-11-03', completed: 0, revenueGrosze: 0 },
      { date: '2026-11-04', completed: 6, revenueGrosze: 60000 },
      { date: '2026-11-05', completed: 5, revenueGrosze: 60000 },
    ]);
    expect(bars.map((b) => b.share)).toEqual([0.5, 0, 1, 1]);
    expect(bars.map((b) => b.best)).toEqual([false, false, true, false]);
  });

  it('is empty when the period had no visits at all', () => {
    expect(dayBars([{ date: '2026-11-02', completed: 0, revenueGrosze: 0 }])).toEqual([]);
    expect(dayBars([])).toEqual([]);
    // Visits without payments still show (bars empty, nobody "best").
    const unpaid = dayBars([{ date: '2026-11-02', completed: 2, revenueGrosze: 0 }]);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).toMatchObject({ share: 0, best: false });
  });

  it('names the day short in every language', () => {
    expect(shortDay('2026-11-02', 'en')).toMatch(/Mon/);
    expect(shortDay('2026-11-02', 'pl')).toMatch(/pon/);
    expect(shortDay('2026-11-02', 'en')).toMatch(/2/);
  });
});
