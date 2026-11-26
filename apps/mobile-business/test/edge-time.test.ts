import { describe, expect, it } from 'vitest';
import type { Calendar } from '../src/api';
import { localToIso } from '../src/blocks';
import { daysOff, staffOfDay, visitActions, visitsOfDay } from '../src/day';
import { dayPlanText } from '../src/dayPlan';
import { newRule } from '../src/happyHours';
import { appendPage, historyLine, type HistoryEntry } from '../src/history';
import { hoursOff, weeklyBody, weekInputs } from '../src/hours';
import { DICTIONARIES } from '../src/i18n';
import { openStatus, salonNow } from '../src/openNow';
import { waitlistStatus } from '../src/waitlist';
import { weekStart, weekSummary } from '../src/week';

const zone = 'Europe/Warsaw';
const en = DICTIONARIES.en;

describe('time off and calendar boundaries', () => {
  it.each([
    ['2024-02-28', '2024-02-29'],
    ['2024-02-29', '2024-03-01'],
    ['2026-12-31', '2027-01-01'],
  ])('ends time off on %s at the following local midnight', (date, nextDate) => {
    expect(daysOff(date, date)).toEqual({ start: `${date}T00:00`, end: `${nextDate}T00:00` });
    expect(hoursOff(date, '23:59–24:00')).toEqual({
      start: `${date}T23:59`,
      end: `${nextDate}T00:00`,
    });
  });

  it.each(['', '2026-2-01', '2025-02-29', '2026-04-31'])(
    'rejects an invalid date %j for either kind of time off',
    (date) => {
      expect(daysOff(date, '2026-12-31')).toBeNull();
      expect(daysOff('2024-01-01', date)).toBeNull();
      expect(hoursOff(date, '12–16')).toBeNull();
      expect(hoursOff(date, '20–24')).toBeNull();
    },
  );

  it('allows hours on the last supported date only when the end stays in range', () => {
    const date = '9000-12-31';
    expect(hoursOff(date, '21–23')).toEqual({ start: '9000-12-31T21:00', end: '9000-12-31T23:00' });
    expect(hoursOff(date, '21–24')).toBeNull();
    expect(daysOff(date, date)).toBeNull();
  });

  it.each([
    ['2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z'],
    ['2026-10-25', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z'],
  ])('covers exactly the local day for a full-day block on %s', (date, start, end) => {
    expect(Date.parse(localToIso(date, '00:00', zone))).toBe(Date.parse(start));
    expect(Date.parse(localToIso(date, '24:00', zone))).toBe(Date.parse(end));
  });

  it('enables attendance only at the booked occurrence of the repeated 02:30', () => {
    const visit = {
      status: 'confirmed',
      start: '2026-10-25T02:30:00+01:00',
      paidAt: null,
    } as const;
    const first = Date.parse('2026-10-25T02:30:00+02:00');
    const second = Date.parse('2026-10-25T02:30:00+01:00');
    const repeatedTime = { date: '2026-10-25', weekday: 7, minute: 150 };
    expect(salonNow(first, zone)).toEqual(repeatedTime);
    expect(salonNow(second, zone)).toEqual(repeatedTime);
    expect(visitActions(visit, true, first)).toMatchObject({ came: false, noShow: false });
    expect(visitActions(visit, true, second)).toMatchObject({ came: true, noShow: true });
  });

  it('keeps the salon closed at midnight even when yesterday had working hours', () => {
    const now = salonNow(Date.parse('2026-12-31T23:00:00Z'), zone);
    expect(now).toEqual({ date: '2027-01-01', weekday: 5, minute: 0 });
    expect(weeklyBody(weekInputs({ weekly: [] }))).toEqual({ ok: true, days: [] });
    const yesterday = { date: '2026-12-31', intervals: [{ start: '00:00', end: '24:00' }] };
    expect(openStatus({ openingHours: [], todayHours: yesterday }, now)).toEqual({
      kind: 'closed',
    });
  });
});

describe('the leap-day visit in the calendar and shared plan', () => {
  const date = '2024-02-29';
  const calendar: Calendar = {
    location: { id: 'salon', name: 'Salon', timezone: zone, currency: 'PLN', slotStepMinutes: 15 },
    from: '2024-02-26',
    to: '2024-03-03',
    staff: [
      {
        id: 'stylist',
        displayName: 'Anna',
        days: [{ date, intervals: [{ start: '20:00', end: '24:00' }] }],
      },
    ],
    timeOff: [],
    blocks: [],
    appointments: [
      {
        id: 'overnight',
        locationId: 'salon',
        date,
        time: '23:45',
        start: '2024-02-29T22:45:00Z',
        end: '2024-02-29T23:30:00Z',
        blockedUntil: '2024-02-29T23:30:00Z',
        status: 'confirmed',
        source: 'manual',
        staff: { id: 'stylist', displayName: 'Anna' },
        service: { id: 'cut', name: 'Cut' },
        customer: null,
        priceGrosze: null,
        discountGrosze: null,
        coupons: [],
        tierDiscount: null,
        staffChosenByClient: false,
        firstVisit: false,
        durationMinutes: 45,
        bufferMinutes: 0,
        note: null,
        wishes: { mood: null, drink: null, note: null },
        holdExpiresAt: null,
        awaitingApproval: false,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        paidAt: null,
        paymentMethod: null,
        tipGrosze: 0,
        version: 1,
        createdAt: '2024-02-01T09:00:00Z',
      },
    ],
  };

  it('counts the overnight visit and its specialist only on the starting day', () => {
    const monday = weekStart('2024-03-01');
    expect(monday).toBe('2024-02-26');
    const week = weekSummary(calendar, monday);
    expect(week.slice(3, 5)).toEqual([
      { date, visits: 1, waiting: 0, span: '23:45–00:30', working: 1 },
      { date: '2024-03-01', visits: 0, waiting: 0, span: null, working: 0 },
    ]);
    expect(visitsOfDay(calendar, '2024-03-01')).toEqual([]);
  });

  it('shares the shift and the overnight visit with the salon-local end time', () => {
    const text = dayPlanText(
      {
        salon: calendar.location.name,
        title: date,
        visits: visitsOfDay(calendar, date),
        working: staffOfDay(calendar, date),
        blocks: [],
      },
      {
        working: en.day.working,
        nobodyWorks: en.day.nobodyWorks,
        empty: en.day.empty,
        blocks: en.blocks.title,
        wholeSalon: en.blocks.wholeSalon,
        walkIn: en.day.walkIn,
        awaitingApproval: en.visit.awaitingApproval,
      },
    );
    expect(text.split('\n')).toContain(`${en.day.working}: Anna 20:00–24:00`);
    expect(text.split('\n')).toContain(`23:45–00:30 · Anna · Cut — ${en.day.walkIn}`);
  });
});

describe('promotion weekdays, waiting list and history', () => {
  it.each([0, 8, 1.5, NaN])('rejects a promotion containing invalid ISO weekday %s', (weekday) => {
    expect(
      newRule({
        weekdays: [7, weekday],
        start: '23:55',
        end: '24:00',
        percent: '10',
        staffIds: [],
      }),
    ).toEqual({ ok: false, problem: 'days' });
  });

  it('shows the local jump between joining the waitlist and being notified', () => {
    expect(
      waitlistStatus(
        {
          status: 'notified',
          createdAt: '2026-03-29T00:55:00Z',
          notifiedAt: '2026-03-29T01:05:00Z',
        },
        zone,
        en.waitlist,
      ),
    ).toBe('Told 03:05 · Joined 01:55');
  });

  const entry: HistoryEntry = {
    id: 'change',
    at: '2026-12-31T23:10:00Z',
    action: 'staff.override_set',
    entityType: 'staff',
    entityId: null,
    entityName: null,
    actor: null,
    fields: null,
    date: '2026-12-31',
  };

  it('distinguishes the new local year of the change from the date that was edited', () => {
    const detail = historyLine(entry, en, 'en', zone);
    expect(detail).toMatch(/1 Jan 2027.*00:10/);
    expect(detail).toMatch(/day: Thu,? 31 Dec$/);
  });

  it('keeps each history id once, including duplicates within the incoming page', () => {
    const older = { ...entry, id: 'older' };
    const oldest = { ...entry, id: 'oldest' };
    expect(
      appendPage(
        [entry],
        [entry, older, { ...older, actor: { id: 'staff', name: 'Anna' } }, oldest],
      ),
    ).toEqual([entry, older, oldest]);
  });
});
