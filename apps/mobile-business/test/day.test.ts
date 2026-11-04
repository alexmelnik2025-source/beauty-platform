import { describe, expect, it } from 'vitest';
import type { Calendar } from '../src/api';
import {
  addDays,
  dayTitle,
  daysOff,
  timeOffText,
  weekRows,
  formatPrice,
  myStaffId,
  onlyMine,
  staffOfDay,
  timeIn,
  todayIn,
  visitActions,
  visitsOfDay,
  type DayVisit,
} from '../src/day';

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
        staffId: 's1',
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

describe('visit card', () => {
  const visit = (staffId: string, id: string) =>
    ({ id, staffId, start: '10:00' }) as unknown as DayVisit;

  it('"only mine" keeps the visits of the signed-in specialist', () => {
    const staff = [
      { id: 's1', userId: 'u-kasia' },
      { id: 's2', userId: null },
    ] as unknown as Parameters<typeof myStaffId>[0];
    expect(myStaffId(staff, 'u-kasia')).toBe('s1');
    expect(myStaffId(staff, 'u-owner')).toBeNull();
    const list = [visit('s1', 'a'), visit('s2', 'b')];
    expect(onlyMine(list, 's1').map((v) => v.id)).toEqual(['a']);
    expect(onlyMine(list, null)).toHaveLength(2);
  });

  it('shows the same buttons as the web calendar', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const started = '2026-11-03T11:00:00Z';
    const later = '2026-11-03T15:00:00Z';
    const none = { came: false, noShow: false, pay: false, unpay: false };
    expect(visitActions({ status: 'confirmed', start: started, paidAt: null }, true, now)).toEqual({
      came: true,
      noShow: true,
      pay: false,
      unpay: false,
    });
    // Not started yet: nothing to mark.
    expect(visitActions({ status: 'confirmed', start: later, paidAt: null }, true, now)).toEqual(
      none,
    );
    expect(visitActions({ status: 'completed', start: started, paidAt: null }, true, now)).toEqual({
      came: false,
      noShow: false,
      pay: true,
      unpay: false,
    });
    expect(
      visitActions({ status: 'completed', start: started, paidAt: started }, true, now),
    ).toEqual({ came: false, noShow: false, pay: false, unpay: true });
    expect(visitActions({ status: 'no_show', start: started, paidAt: null }, true, now)).toEqual(
      none,
    );
    // Without the permission to change visits: only reading.
    expect(visitActions({ status: 'confirmed', start: started, paidAt: null }, false, now)).toEqual(
      none,
    );
  });

  it('prices in złoty', () => {
    expect(formatPrice(4500, 'pl').replace(/\s/g, ' ')).toBe('45,00 zł');
    expect(formatPrice(4500, 'en')).toContain('45.00');
  });
});

describe('my schedule', () => {
  it('lists Monday to Sunday with hours or a day off', () => {
    const rows = weekRows(
      {
        timezone: 'Europe/Warsaw',
        weekly: [
          {
            weekday: 1,
            intervals: [
              { start: '09:00', end: '14:00' },
              { start: '15:00', end: '20:00' },
            ],
          },
          { weekday: 6, intervals: [{ start: '10:00', end: '16:00' }] },
        ],
        overrides: [],
      },
      'pl',
    );
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({
      weekday: 1,
      name: 'poniedziałek',
      hours: '09:00–14:00, 15:00–20:00',
    });
    expect(rows[1]?.hours).toBeNull();
    expect(rows[5]).toMatchObject({ name: 'sobota', hours: '10:00–16:00' });
    expect(rows[6]?.name).toBe('niedziela');
  });

  it('whole days off: the end is the next midnight', () => {
    expect(daysOff('2026-12-24', '2026-12-26')).toEqual({
      start: '2026-12-24T00:00',
      end: '2026-12-27T00:00',
    });
    expect(daysOff('2026-12-24', '2026-12-24')).toEqual({
      start: '2026-12-24T00:00',
      end: '2026-12-25T00:00',
    });
    expect(daysOff('2026-12-24', '2026-12-23')).toBeNull();
  });

  it('describes time off in words', () => {
    const one = timeOffText({ start: '2026-12-24T00:00', end: '2026-12-25T00:00' }, 'en');
    expect(one).toContain('24');
    expect(one).not.toContain('–');
    const days = timeOffText({ start: '2026-12-24T00:00', end: '2026-12-27T00:00' }, 'en');
    expect(days).toMatch(/24.*–.*26/);
    expect(timeOffText({ start: '2026-12-24T10:00', end: '2026-12-24T14:00' }, 'en')).toMatch(
      /24.* 10:00–14:00$/,
    );
    expect(timeOffText({ start: '2026-12-24T10:00', end: '2026-12-25T12:00' }, 'en')).toMatch(
      /24.* 10:00 – .*25.* 12:00$/,
    );
  });
});
