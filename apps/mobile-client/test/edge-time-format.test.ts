import { describe, expect, it } from 'vitest';
import type { Slot } from '../src/api';
import { countdown, dayParts } from '../src/booking';
import { extraText } from '../src/bonus';
import {
  dayChip,
  formatDate,
  formatDay,
  formatMoment,
  formatPrice,
  slotsByDay,
  visitSummaryLines,
} from '../src/format';
import { DICTIONARIES } from '../src/i18n';

const warsaw = 'Europe/Warsaw';

describe.each([
  {
    locale: 'pl',
    leapDay: 'wtorek, 29 lutego',
    newYear: '1 stycznia 2027',
    march: '29 marca',
    october: '25 października',
    prices: ['0,00 zł', '0,01 zł', '-0,01 zł', '21 474 836,47 zł'],
  },
  {
    locale: 'en',
    leapDay: 'Tuesday 29 February',
    newYear: '1 January 2027',
    march: '29 March',
    october: '25 October',
    prices: ['PLN 0.00', 'PLN 0.01', '-PLN 0.01', 'PLN 21,474,836.47'],
  },
  {
    locale: 'uk',
    leapDay: 'вівторок, 29 лютого',
    newYear: '1 січня 2027',
    march: '29 березня',
    october: '25 жовтня',
    prices: ['0,00 PLN', '0,01 PLN', '-0,01 PLN', '21 474 836,47 PLN'],
  },
  {
    locale: 'ru',
    leapDay: 'вторник, 29 февраля',
    newYear: '1 января 2027',
    march: '29 марта',
    october: '25 октября',
    prices: ['0,00 PLN', '0,01 PLN', '-0,01 PLN', '21 474 836,47 PLN'],
  },
] as const)(
  'dates, times and prices in $locale',
  ({ locale, leapDay, newYear, march, october, prices }) => {
    it('keeps leap day and changes the year at midnight in the salon', () => {
      expect(formatDay('2028-02-29', locale)).toBe(leapDay);
      expect(formatDate('2026-12-31T23:00:00Z', warsaw, locale)).toContain(newYear);
    });

    it.each([
      ['2026-03-29T00:59:00Z', march, '01:59'],
      ['2026-03-29T01:00:00Z', march, '03:00'],
      ['2026-10-25T00:59:00Z', october, '02:59'],
      ['2026-10-25T01:00:00Z', october, '02:00'],
    ])('shows the salon clock at %s', (instant, day, time) => {
      const label = formatMoment(instant, warsaw, locale);
      expect(label).toContain(day);
      expect(label).toContain(time);
    });

    it('keeps zero, a single grosz, a refund and the largest database integer distinct', () => {
      const amounts = [0, 1, -1, 2_147_483_647];
      expect(
        amounts.map((amount) => formatPrice(amount, 'PLN', locale).replace(/\s/g, ' ')),
      ).toEqual(prices);
    });
  },
);

describe('damaged visit and price data', () => {
  it.each(['2027-02-29', '2026-04-31', ''])('does not show a different day for "%s"', (date) => {
    expect(formatDay(date, 'en')).toBe('—');
    expect(dayChip(date, 'en')).toEqual({ weekday: '', day: '—' });
  });

  it.each([
    ['not an instant', warsaw],
    ['2026-11-26T12:00:00Z', 'Europe/Unknown'],
  ])('keeps an unreadable salon date out of a visit label', (instant, zone) => {
    expect(formatMoment(instant, zone, 'uk')).toBe('—');
    expect(formatDate(instant, zone, 'uk')).toBe('—');
  });

  it.each(['0', '2026-02-31T09:00Z', '2028-03-01T00:30:00'])(
    'ignores the damaged instant "%s" and keeps the valid slot',
    (start) => {
      const good: Slot = {
        start: '2028-03-01T00:30:00+01:00',
        date: '2028-03-01',
        time: '00:30',
        staffIds: ['kasia'],
        discountPercent: null,
      };
      expect(slotsByDay([{ ...good, start }, good])).toEqual([{ date: good.date, slots: [good] }]);
      expect(formatDate(good.start, 'UTC', 'en')).toBe('29 February 2028');
      expect(formatDate(start, warsaw, 'en')).toBe('—');
      expect(countdown(start, Date.parse('1999-12-31T23:59:59Z'))).toBe('0:00');
    },
  );

  it.each([
    [NaN, 'PLN'],
    [Infinity, 'EUR'],
    [1250, ''],
    [1250, 'zł'],
  ] as const)('does not display an unusable price (%s, "%s")', (amount, currency) => {
    expect(formatPrice(amount, currency, 'pl')).toBe('—');
  });
});

describe('Polish counts', () => {
  it.each([1, 2, 5, 22, 112])('uses the count label for %i completed visits', (completed) => {
    const lines = visitSummaryLines(
      { completed, salons: 1, firstVisitAt: null, spent: [] },
      DICTIONARIES.pl.visits,
      'pl',
    );
    expect(lines.visits).toBe(`Odbyte wizyty: ${completed}`);
  });

  it.each([2, 5, 22, 112])('uses the plural in a bonus rule valid for %i days', (withinDays) => {
    const rule = {
      name: 'Powrót',
      staffNames: [],
      weekdays: [],
      multiplier: 2,
      extraPoints: 0,
      withinDays,
    };
    expect(extraText(DICTIONARIES.pl, rule, 'pl')).toBe(`gdy wracasz w ciągu ${withinDays} dni`);
  });
});

describe('booking clock boundaries', () => {
  it('groups midnight, noon and the first evening slot by the salon clock', () => {
    const slot = (time: string): Slot => ({
      date: '2026-12-31',
      start: `2026-12-31T${time}:00+01:00`,
      time,
      staffIds: ['kasia'],
      discountPercent: null,
    });
    const times = ['00:00', '11:59', '12:00', '16:59', '17:00', '23:59'];
    const parts = dayParts(times.map(slot));
    expect(parts.map(({ part, slots }) => [part, slots.map((entry) => entry.time)])).toEqual([
      ['morning', ['00:00', '11:59']],
      ['afternoon', ['12:00', '16:59']],
      ['evening', ['17:00', '23:59']],
    ]);
  });

  it('counts whole seconds until a hold expires at the year boundary', () => {
    const expiry = '2027-01-01T00:00:00+01:00';
    expect(countdown(expiry, Date.parse('2026-12-31T22:59:59.000Z'))).toBe('0:01');
    expect(countdown(expiry, Date.parse('2026-12-31T22:59:59.001Z'))).toBe('0:00');
    expect(countdown(expiry, Date.parse('2026-12-31T23:00:00.000Z'))).toBe('0:00');
  });
});
