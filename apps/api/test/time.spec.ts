import { describe, expect, it } from 'vitest';
import {
  addDays,
  instantToLocal,
  isoWeekday,
  isValidLocalDate,
  offsetMinutes,
  parseClock,
  parseLocalDateTime,
  zonedToInstant,
} from '../src/scheduling/time';

const WARSAW = 'Europe/Warsaw';
const iso = (instant: number) => new Date(instant).toISOString();

describe('time zones (Europe/Warsaw)', () => {
  it('knows the winter and summer offsets', () => {
    expect(offsetMinutes(Date.parse('2026-01-15T12:00:00Z'), WARSAW)).toBe(60);
    expect(offsetMinutes(Date.parse('2026-07-15T12:00:00Z'), WARSAW)).toBe(120);
  });

  it('converts local wall-clock time to the right instant', () => {
    expect(iso(zonedToInstant('2026-01-15', 9 * 60, WARSAW))).toBe('2026-01-15T08:00:00.000Z');
    expect(iso(zonedToInstant('2026-07-15', 9 * 60, WARSAW))).toBe('2026-07-15T07:00:00.000Z');
    expect(iso(zonedToInstant('2026-10-22', 24 * 60, WARSAW))).toBe('2026-10-22T22:00:00.000Z');
  });

  it('29.03.2026 (clocks forward): 02:30 does not exist and becomes 03:30', () => {
    const instant = zonedToInstant('2026-03-29', 2 * 60 + 30, WARSAW);
    expect(iso(instant)).toBe('2026-03-29T01:30:00.000Z');
    expect(instantToLocal(instant, WARSAW).time).toBe('03:30');
  });

  it('25.10.2026 (clocks back): 02:30 happens twice; the earlier one is used', () => {
    expect(iso(zonedToInstant('2026-10-25', 2 * 60 + 30, WARSAW))).toBe('2026-10-25T00:30:00.000Z');
  });

  it('works for other zones too (New York transitions)', () => {
    expect(iso(zonedToInstant('2026-03-08', 2 * 60 + 30, 'America/New_York'))).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(iso(zonedToInstant('2026-11-01', 60 + 30, 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('converts instants back to local date and time', () => {
    expect(instantToLocal(Date.parse('2026-10-22T22:30:00Z'), WARSAW)).toEqual({
      date: '2026-10-23',
      minute: 30,
      time: '00:30',
    });
  });
});

describe('dates and clock values', () => {
  it('computes ISO weekdays and adds days across months and years', () => {
    expect(isoWeekday('2026-10-22')).toBe(4); // Thursday
    expect(isoWeekday('2026-10-25')).toBe(7); // Sunday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('validates dates and clock values', () => {
    expect(isValidLocalDate('2026-02-29')).toBe(false);
    expect(isValidLocalDate('2028-02-29')).toBe(true);
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    expect(parseClock('24:30')).toBeNull();
    expect(parseClock('9:30')).toBeNull();
    expect(parseLocalDateTime('2026-12-24T00:00', WARSAW)).toBe(Date.parse('2026-12-23T23:00:00Z'));
    expect(parseLocalDateTime('2026-02-30T00:00', WARSAW)).toBeNull();
  });
});
