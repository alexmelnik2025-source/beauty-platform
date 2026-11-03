import { describe, expect, it } from 'vitest';
import type { Calendar } from '../src/api';
import { addDays, dayTitle, staffOfDay, timeIn, todayIn, visitsOfDay } from '../src/day';

const appointment = (
  id: string,
  start: string,
  end: string,
  time: string,
  status: Calendar['appointments'][number]['status'],
  customer: { name: string; phone: string | null } | null,
) =>
  ({
    id,
    locationId: 'l1',
    status,
    source: 'online',
    start,
    end,
    blockedUntil: end,
    date: '2026-11-03',
    time,
    staff: { id: 's1', displayName: 'Kasia' },
    service: { id: 'v1', name: 'Strzyżenie męskie' },
    customer: customer ? { id: `c-${id}`, email: null, ...customer } : null,
  }) as unknown as Calendar['appointments'][number];

const calendar = {
  location: { id: 'l1', name: 'Gestalt', timezone: 'Europe/Warsaw', slotStepMinutes: 15 },
  from: '2026-11-03',
  to: '2026-11-03',
  staff: [
    {
      id: 's1',
      displayName: 'Kasia',
      days: [
        {
          date: '2026-11-03',
          intervals: [
            { start: '08:00', end: '14:00' },
            { start: '15:00', end: '21:00' },
          ],
        },
      ],
    },
    { id: 's2', displayName: 'Ola', days: [{ date: '2026-11-03', intervals: [] }] },
  ],
  timeOff: [],
  blocks: [],
  appointments: [
    appointment('b', '2026-11-03T13:00:00Z', '2026-11-03T13:45:00Z', '14:00', 'confirmed', {
      name: 'Anna',
      phone: null,
    }),
    appointment('a', '2026-11-03T08:30:00Z', '2026-11-03T09:15:00Z', '09:30', 'completed', {
      name: 'Piotr',
      phone: '+48600500600',
    }),
    appointment('c', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z', '11:00', 'cancelled', null),
    appointment('d', '2026-11-03T11:00:00Z', '2026-11-03T11:30:00Z', '12:00', 'held', null),
  ],
} as unknown as Calendar;

describe('day calendar', () => {
  it('today is the salon’s date, not the phone’s', () => {
    // 23:30 UTC on 2 Nov is already 3 Nov in Warsaw (UTC+1).
    const now = new Date('2026-11-02T23:30:00Z');
    expect(todayIn('Europe/Warsaw', now)).toBe('2026-11-03');
    expect(todayIn('UTC', now)).toBe('2026-11-02');
  });

  it('moves between days across months and years', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('names the day in each language', () => {
    expect(dayTitle('2026-11-03', 'pl')).toBe('wtorek, 3 listopada');
    expect(dayTitle('2026-11-03', 'en')).toMatch(/Tuesday/);
    expect(dayTitle('2026-11-03', 'uk')).toMatch(/вівторок/);
    expect(dayTitle('2026-11-03', 'ru')).toMatch(/вторник/);
  });

  it('end times are shown in the salon’s time zone', () => {
    expect(timeIn('2026-11-03T13:45:00Z', 'Europe/Warsaw')).toBe('14:45');
    expect(timeIn('2026-07-01T13:45:00Z', 'Europe/Warsaw')).toBe('15:45');
  });

  it('lists what will happen, in time order, without cancelled visits and held slots', () => {
    expect(visitsOfDay(calendar, '2026-11-03')).toEqual([
      {
        id: 'a',
        start: '09:30',
        end: '10:15',
        status: 'completed',
        service: 'Strzyżenie męskie',
        staff: 'Kasia',
        customer: 'Piotr',
        phone: '+48600500600',
      },
      expect.objectContaining({ id: 'b', start: '14:00', end: '14:45', phone: null }),
    ]);
    expect(visitsOfDay(calendar, '2026-11-04')).toEqual([]);
  });

  it('shows who works that day', () => {
    expect(staffOfDay(calendar, '2026-11-03')).toEqual([
      { name: 'Kasia', hours: '08:00–14:00, 15:00–21:00' },
    ]);
  });
});
