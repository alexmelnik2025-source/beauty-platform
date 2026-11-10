import { describe, expect, it } from 'vitest';
import { hoursOn } from '../src/scheduling/today-hours';
import { zonedToInstant } from '../src/scheduling/time';

const TZ = 'Europe/Warsaw';
/** A Wednesday. */
const DAY = '2027-03-10';
const at = (minute: number, date = DAY) => zonedToInstant(date, minute, TZ);
const week = (start: number, end: number) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: start, endMinute: end }));

describe('hoursOn (task 362)', () => {
  it('merges the hours of everyone, by the weekday of the date', () => {
    expect(
      hoursOn(
        DAY,
        TZ,
        [
          { weekly: [{ weekday: 3, startMinute: 540, endMinute: 780 }], overrides: [], off: [] },
          { weekly: [{ weekday: 3, startMinute: 720, endMinute: 1020 }], overrides: [], off: [] },
          { weekly: [{ weekday: 4, startMinute: 0, endMinute: 1440 }], overrides: [], off: [] },
          { weekly: [{ weekday: 3, startMinute: 1080, endMinute: 1200 }], overrides: [], off: [] },
        ],
        [],
      ),
    ).toEqual([
      { start: '09:00', end: '17:00' },
      { start: '18:00', end: '20:00' },
    ]);
  });

  it('special hours replace the weekly ones', () => {
    expect(
      hoursOn(
        DAY,
        TZ,
        [{ weekly: week(540, 1020), overrides: [{ startMinute: 600, endMinute: 840 }], off: [] }],
        [],
      ),
    ).toEqual([{ start: '10:00', end: '14:00' }]);
  });

  it('vacations cut a specialist’s hours; a vacation of several days closes the whole day', () => {
    const staff = (off: { start: number; end: number }[]) => ({
      weekly: week(540, 1020),
      overrides: [],
      off,
    });
    expect(hoursOn(DAY, TZ, [staff([{ start: at(720), end: at(780) }])], [])).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ]);
    expect(
      hoursOn(DAY, TZ, [staff([{ start: at(0, '2027-03-08'), end: at(0, '2027-03-15') }])], []),
    ).toEqual([]);
    // Another specialist still works, so the salon is open.
    expect(
      hoursOn(
        DAY,
        TZ,
        [staff([{ start: at(0, '2027-03-08'), end: at(0, '2027-03-15') }]), staff([])],
        [],
      ),
    ).toEqual([{ start: '09:00', end: '17:00' }]);
    // Yesterday's vacation changes nothing.
    expect(
      hoursOn(DAY, TZ, [staff([{ start: at(0, '2027-03-09'), end: at(0, DAY) }])], []),
    ).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('salon-wide blocks cut everyone; a block until tomorrow closes the rest of the day', () => {
    const staff = { weekly: week(540, 1020), overrides: [], off: [] };
    expect(hoursOn(DAY, TZ, [staff], [{ start: at(900), end: at(0, '2027-03-11') }])).toEqual([
      { start: '09:00', end: '15:00' },
    ]);
  });

  it('nobody in the team: closed', () => {
    expect(hoursOn(DAY, TZ, [], [])).toEqual([]);
  });

  it('works on the day clocks change', () => {
    // 2027-03-28: Warsaw moves from 02:00 to 03:00.
    expect(
      hoursOn(
        '2027-03-28',
        TZ,
        [
          {
            weekly: week(600, 1080),
            overrides: [],
            off: [{ start: at(720, '2027-03-28'), end: at(780, '2027-03-28') }],
          },
        ],
        [],
      ),
    ).toEqual([
      { start: '10:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
    ]);
  });
});
