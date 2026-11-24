import { describe, expect, it } from 'vitest';
import { DICTIONARIES } from '../src/i18n';
import { openStatus, openStatusText, salonNow, todayHoursText } from '../src/openNow';

const week = (start: string, end: string) =>
  [1, 2, 3, 4, 5].map((weekday) => ({ weekday, intervals: [{ start, end }] }));
// Wednesday 11.11.2026, 12:30 in Warsaw (11:30 UTC).
const NOON = Date.UTC(2026, 10, 11, 11, 30);
const pl = DICTIONARIES.pl.clientsNow;

describe('"Klienci widzą teraz" (task 366)', () => {
  it('is the salon’s local time', () => {
    expect(salonNow(NOON, 'Europe/Warsaw')).toEqual({
      date: '2026-11-11',
      weekday: 3,
      minute: 12 * 60 + 30,
    });
  });

  it('switches from yesterday’s actual hours to the new weekday at local midnight', () => {
    const salon = {
      openingHours: [{ weekday: 1, intervals: [{ start: '00:00', end: '01:00' }] }],
      todayHours: { date: '2026-11-15', intervals: [] },
    };
    const statusAt = (instant: string) =>
      openStatus(salon, salonNow(Date.parse(instant), 'Europe/Warsaw'));
    expect(statusAt('2026-11-15T22:59:00Z')).toEqual({
      kind: 'opensLater',
      inDays: 1,
      weekday: 1,
      at: '00:00',
    });
    expect(statusAt('2026-11-15T23:00:00Z')).toEqual({ kind: 'open', until: '01:00' });
    expect(statusAt('2026-11-16T00:00:00Z')).toEqual({
      kind: 'opensLater',
      inDays: 7,
      weekday: 1,
      at: '00:00',
    });
  });

  it('follows a night shift across the week boundary, then skips a day off', () => {
    // The public timetable splits the shift at midnight on the salon's local dates.
    const salon = {
      openingHours: [
        { weekday: 7, intervals: [{ start: '22:00', end: '24:00' }] },
        { weekday: 1, intervals: [{ start: '00:00', end: '02:00' }] },
        { weekday: 3, intervals: [{ start: '09:00', end: '16:00' }] },
      ],
      todayHours: { date: '2026-11-15', intervals: [{ start: '22:00', end: '24:00' }] },
    };
    const statusAt = (instant: string) =>
      openStatus(salon, salonNow(Date.parse(instant), 'Europe/Warsaw'));
    expect(statusAt('2026-11-15T21:00:00Z')).toEqual({ kind: 'open', until: '24:00' });
    expect(statusAt('2026-11-15T22:59:00Z')).toEqual({ kind: 'open', until: '24:00' });
    expect(statusAt('2026-11-15T23:00:00Z')).toEqual({ kind: 'open', until: '02:00' });
    expect(statusAt('2026-11-16T01:00:00Z')).toEqual({
      kind: 'opensLater',
      inDays: 2,
      weekday: 3,
      at: '09:00',
    });
  });

  it('opens at 03:00 as Warsaw skips from 01:59 to 03:00 in spring', () => {
    const salon = {
      openingHours: [],
      todayHours: { date: '2026-03-29', intervals: [{ start: '03:00', end: '04:00' }] },
    };
    const statusAt = (instant: string) =>
      openStatus(salon, salonNow(Date.parse(instant), 'Europe/Warsaw'));
    expect(statusAt('2026-03-29T00:59:00Z')).toEqual({ kind: 'opensToday', at: '03:00' });
    expect(statusAt('2026-03-29T01:00:00Z')).toEqual({ kind: 'open', until: '04:00' });
    expect(statusAt('2026-03-29T02:00:00Z')).toEqual({ kind: 'closed' });
  });

  it.each(['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'])(
    'is open at both occurrences of 02:30 in Warsaw (%s)',
    (instant) => {
      const now = salonNow(Date.parse(instant), 'Europe/Warsaw');
      expect(
        openStatus(
          {
            openingHours: [],
            todayHours: { date: '2026-10-25', intervals: [{ start: '02:30', end: '02:45' }] },
          },
          now,
        ),
      ).toEqual({ kind: 'open', until: '02:45' });
    },
  );

  it('says until when the salon is open, with hours that continue without a break', () => {
    const salon = {
      openingHours: week('09:00', '20:00'),
      todayHours: {
        date: '2026-11-11',
        intervals: [
          { start: '14:00', end: '20:00' },
          { start: '09:00', end: '14:00' },
        ],
      },
    };
    const now = salonNow(NOON, 'Europe/Warsaw');
    expect(openStatus(salon, now)).toEqual({ kind: 'open', until: '20:00' });
    expect(openStatusText(openStatus(salon, now), pl, 'pl')).toBe('Otwarte · do 20:00');
    expect(openStatusText({ kind: 'open', until: '24:00' }, DICTIONARIES.en.clientsNow, 'en')).toBe(
      'Open · until midnight',
    );
  });

  it('follows today’s real hours: a vacation closes the salon until the next working day', () => {
    const salon = {
      openingHours: week('10:00', '18:00'),
      todayHours: { date: '2026-11-11', intervals: [] },
    };
    const status = openStatus(salon, salonNow(NOON, 'Europe/Warsaw'));
    expect(status).toEqual({ kind: 'opensLater', inDays: 1, weekday: 4, at: '10:00' });
    expect(openStatusText(status, pl, 'pl')).toBe('Zamknięte · otwarcie: jutro, 10:00');
    expect(todayHoursText({ ...salon, timezone: 'Europe/Warsaw' }, NOON)).toBe('');
  });

  it('opens later today after a break, and names the weekday further on', () => {
    const salon = {
      openingHours: week('09:00', '17:00'),
      todayHours: { date: '2026-11-11', intervals: [{ start: '15:00', end: '19:00' }] },
    };
    expect(openStatusText(openStatus(salon, salonNow(NOON, 'Europe/Warsaw')), pl, 'pl')).toBe(
      'Zamknięte · otwarcie o 15:00',
    );
    // Friday evening: Monday is the next working day.
    const friday = Date.UTC(2026, 10, 13, 19, 0);
    const status = openStatus(
      { ...salon, todayHours: { date: '2026-11-13', intervals: [] } },
      salonNow(friday, 'Europe/Warsaw'),
    );
    expect(status).toEqual({ kind: 'opensLater', inDays: 3, weekday: 1, at: '09:00' });
    expect(openStatusText(status, DICTIONARIES.uk.clientsNow, 'uk')).toBe(
      'Зачинено · відчиниться: понеділок, 09:00',
    );
    expect(
      openStatus(
        { openingHours: [], todayHours: salon.todayHours },
        salonNow(friday, 'Europe/Warsaw'),
      ),
    ).toEqual({
      kind: 'closed',
    });
  });

  it('shows today’s hours in order; the weekly ones when today is not known yet', () => {
    const salon = {
      timezone: 'Europe/Warsaw',
      openingHours: week('09:00', '17:00'),
      todayHours: {
        date: '2026-11-11',
        intervals: [
          { start: '15:00', end: '20:00' },
          { start: '09:00', end: '13:00' },
        ],
      },
    };
    expect(todayHoursText(salon, NOON)).toBe('09:00–13:00, 15:00–20:00');
    expect(
      todayHoursText({ ...salon, todayHours: { date: '2026-11-10', intervals: [] } }, NOON),
    ).toBe('09:00–17:00');
  });
});
