import { describe, expect, it } from 'vitest';
import { onlineShare, reportRange } from '../src/reports';

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
});
