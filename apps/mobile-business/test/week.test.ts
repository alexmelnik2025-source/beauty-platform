import { describe, expect, it } from 'vitest';
import type { Calendar } from '../src/api';
import { weekStart, weekSummary } from '../src/week';

/** Task 214: "Tydzień" in the business app. */

const visit = (
  id: string,
  date: string,
  time: string,
  start: string,
  end: string,
  status: string,
  awaitingApproval = false,
) =>
  ({
    id,
    date,
    time,
    start,
    end,
    status,
    awaitingApproval,
    staff: { id: 's1', displayName: 'Kasia' },
    service: { id: 'v1', name: 'Strzyżenie' },
    customer: null,
  }) as unknown as Calendar['appointments'][number];

describe('week overview', () => {
  it('the week starts on Monday, also across a month and a year', () => {
    expect(weekStart('2026-11-02')).toBe('2026-11-02'); // Monday
    expect(weekStart('2026-11-07')).toBe('2026-11-02'); // Saturday
    expect(weekStart('2026-11-08')).toBe('2026-11-02'); // Sunday
    expect(weekStart('2027-01-01')).toBe('2026-12-28'); // Friday
  });

  it('counts visits that are not cancelled, their span, waiting ones and who works', () => {
    const calendar = {
      location: { timezone: 'Europe/Warsaw' },
      staff: [
        {
          id: 's1',
          displayName: 'Kasia',
          days: [
            { date: '2026-11-02', intervals: [{ start: '09:00', end: '17:00' }] },
            { date: '2026-11-03', intervals: [{ start: '09:00', end: '17:00' }] },
          ],
        },
        {
          id: 's2',
          displayName: 'Ola',
          days: [{ date: '2026-11-02', intervals: [{ start: '12:00', end: '20:00' }] }],
        },
      ],
      appointments: [
        // Monday: 17:00–17:45 ends last although it starts after the 10:00 one.
        visit(
          'b',
          '2026-11-02',
          '17:00',
          '2026-11-02T16:00:00Z',
          '2026-11-02T16:45:00Z',
          'confirmed',
        ),
        visit(
          'a',
          '2026-11-02',
          '10:00',
          '2026-11-02T09:00:00Z',
          '2026-11-02T09:30:00Z',
          'completed',
        ),
        visit(
          'c',
          '2026-11-02',
          '12:00',
          '2026-11-02T11:00:00Z',
          '2026-11-02T11:30:00Z',
          'cancelled',
        ),
        visit('d', '2026-11-02', '13:00', '2026-11-02T12:00:00Z', '2026-11-02T12:30:00Z', 'held'),
        // Tuesday: one waiting for the salon's answer.
        visit(
          'e',
          '2026-11-03',
          '09:00',
          '2026-11-03T08:00:00Z',
          '2026-11-03T08:30:00Z',
          'confirmed',
          true,
        ),
      ],
    } as unknown as Calendar;

    const week = weekSummary(calendar, '2026-11-02');
    expect(week.map((d) => d.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(week[0]).toEqual({
      date: '2026-11-02',
      visits: 2,
      waiting: 0,
      span: '10:00–17:45',
      working: 2,
    });
    expect(week[1]).toEqual({
      date: '2026-11-03',
      visits: 1,
      waiting: 1,
      span: '09:00–09:30',
      working: 1,
    });
    expect(week[2]).toEqual({ date: '2026-11-04', visits: 0, waiting: 0, span: null, working: 0 });
  });
});
