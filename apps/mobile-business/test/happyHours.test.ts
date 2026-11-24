import { describe, expect, it } from 'vitest';
import {
  daysText,
  namesText,
  newLastMinuteRule,
  newRule,
  parseClock,
  rulesToSave,
  type Rule,
} from '../src/happyHours';

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id,
  weekdays: [2],
  start: '10:00',
  end: '13:00',
  discountPercent: 20,
  kind: 'hours',
  lastMinuteHours: null,
  staffIds: [],
  serviceIds: [],
  ...over,
});

describe('happy hours texts', () => {
  it('days in order, every day in one word', () => {
    expect(daysText([4, 2], 'en', 'Every day')).toBe('Tue, Thu');
    expect(daysText([1, 2, 3, 4, 5, 6, 7], 'pl', 'Codziennie')).toBe('Codziennie');
  });

  it('names of specialists or services; none = everyone', () => {
    const names = new Map([
      ['s1', 'Kasia'],
      ['s2', 'Marek'],
    ]);
    expect(namesText([], names, 'wszyscy')).toBe('wszyscy');
    expect(namesText(['s2', 's1'], names, 'wszyscy')).toBe('Marek, Kasia');
    expect(namesText(['gone'], names, 'wszyscy')).toBe('wszyscy');
  });
});

describe('parseClock', () => {
  it('takes times on a 5-minute mark, up to 24:00', () => {
    expect(parseClock('9:00')).toBe('09:00');
    expect(parseClock(' 13.30 ')).toBe('13:30');
    expect(parseClock('24:00')).toBe('24:00');
    expect(parseClock('24:05')).toBeNull();
    expect(parseClock('10:07')).toBeNull();
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('10')).toBeNull();
  });
});

describe('newRule', () => {
  const form = { weekdays: [4, 2], start: '10:00', end: '13:00', percent: '20', staffIds: ['s1'] };

  it('a rule for the chosen days, hours and specialists; all services', () => {
    expect(newRule(form)).toEqual({
      ok: true,
      rule: {
        weekdays: [2, 4],
        start: '10:00',
        end: '13:00',
        discountPercent: 20,
        staffIds: ['s1'],
        serviceIds: [],
      },
    });
  });

  it('says what is wrong', () => {
    expect(newRule({ ...form, weekdays: [] })).toEqual({ ok: false, problem: 'days' });
    expect(newRule({ ...form, start: 'rano' })).toEqual({ ok: false, problem: 'clock' });
    expect(newRule({ ...form, start: '13:00', end: '10:00' })).toEqual({
      ok: false,
      problem: 'hours',
    });
    expect(newRule({ ...form, percent: '95' })).toEqual({ ok: false, problem: 'percent' });
    expect(newRule({ ...form, percent: '' })).toEqual({ ok: false, problem: 'percent' });
  });
});

describe('newLastMinuteRule', () => {
  const form = { hours: '1', percent: '20%', staffIds: ['s1'] };

  it.each([1, 72])('accepts a window of %i hours', (hours) => {
    expect(newLastMinuteRule({ ...form, hours: String(hours) })).toEqual({
      ok: true,
      rule: {
        kind: 'lastMinute',
        lastMinuteHours: hours,
        discountPercent: 20,
        staffIds: ['s1'],
        serviceIds: [],
      },
    });
  });

  it.each(['0', '73', '1.5', ''])('rejects an invalid window (%j)', (hours) => {
    expect(newLastMinuteRule({ ...form, hours })).toEqual({
      ok: false,
      problem: 'lastMinuteHours',
    });
  });

  it('rejects a percent sign between digits instead of joining the digits', () => {
    expect(newLastMinuteRule({ ...form, percent: '2%0' })).toEqual({
      ok: false,
      problem: 'percent',
    });
  });
});

describe('discount limits for hours and Last Minute promotions', () => {
  const hours = (percent: string) =>
    newRule({ weekdays: [1], start: '09:00', end: '12:00', percent, staffIds: [] });
  const lastMinute = (percent: string) => newLastMinuteRule({ hours: '24', percent, staffIds: [] });

  it.each([1, 90])('accepts the inclusive limit of %i percent', (percent) => {
    for (const create of [hours, lastMinute]) {
      expect(create(String(percent))).toMatchObject({
        ok: true,
        rule: { discountPercent: percent },
      });
    }
  });

  it.each(['0', '91', '1.5', '0x10', '2e1'])('rejects %j as a discount', (percent) => {
    for (const create of [hours, lastMinute]) {
      expect(create(percent)).toEqual({ ok: false, problem: 'percent' });
    }
  });
});

describe('rulesToSave', () => {
  it('preserves both kinds and their settings when removing from a mixed list', () => {
    const hours = rule('h', { serviceIds: ['haircut'] });
    const lastMinute = rule('lm', {
      kind: 'lastMinute',
      lastMinuteHours: 72,
      weekdays: [],
      start: '00:00',
      end: '24:00',
      staffIds: ['anna'],
    });
    const saved = rulesToSave([hours, rule('removed'), lastMinute], { remove: 'removed' });
    expect(saved).toMatchObject([
      { kind: 'hours', lastMinuteHours: null, serviceIds: ['haircut'] },
      { kind: 'lastMinute', lastMinuteHours: 72, staffIds: ['anna'] },
    ]);
    expect(saved.some((entry) => 'id' in entry)).toBe(false);
  });

  it('keeps the other rules, drops one, adds one — without server ids', () => {
    const current = [rule('a'), rule('b', { discountPercent: 10, serviceIds: ['x'] })];
    const add = {
      weekdays: [5],
      start: '10:00',
      end: '13:00',
      discountPercent: 20,
      staffIds: [],
      serviceIds: [],
    };
    const saved = rulesToSave(current, { remove: 'a', add });
    expect(saved).toEqual([
      {
        weekdays: [2],
        start: '10:00',
        end: '13:00',
        discountPercent: 10,
        kind: 'hours',
        lastMinuteHours: null,
        staffIds: [],
        serviceIds: ['x'],
      },
      {
        weekdays: [5],
        start: '10:00',
        end: '13:00',
        discountPercent: 20,
        staffIds: [],
        serviceIds: [],
      },
    ]);
    expect(saved.some((r) => 'id' in r)).toBe(false);
  });
});
