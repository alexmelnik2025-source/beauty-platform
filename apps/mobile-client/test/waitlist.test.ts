import { describe, expect, it } from 'vitest';
import { waitlistDays } from '../src/waitlist';

describe('waitlistDays', () => {
  it('offers no days for an empty window or when every day has a free time', () => {
    expect(waitlistDays('2026-12-31', [], 0)).toEqual([]);
    expect(waitlistDays('2026-12-31', ['2027-01-01', '2026-12-31', '2026-12-31'], 2)).toEqual([]);
  });

  it('offers only the days of the window without free times', () => {
    expect(waitlistDays('2026-11-28', ['2026-11-28', '2026-12-01'], 5)).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-02',
    ]);
    expect(waitlistDays('2026-11-28', [], 2)).toEqual(['2026-11-28', '2026-11-29']);
  });
});
