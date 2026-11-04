import { describe, expect, it } from 'vitest';
import { waitlistDays } from '../src/waitlist';

describe('waitlistDays', () => {
  it('offers only the days of the window without free times', () => {
    expect(waitlistDays('2026-11-28', ['2026-11-28', '2026-12-01'], 5)).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-02',
    ]);
    expect(waitlistDays('2026-11-28', [], 2)).toEqual(['2026-11-28', '2026-11-29']);
  });
});
