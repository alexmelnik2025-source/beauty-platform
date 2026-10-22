import { describe, expect, it } from 'vitest';
import {
  mergeSlots,
  staffSlots,
  type SlotQuery,
  type StaffSchedule,
} from '../src/scheduling/slots';
import { instantToLocal, zonedToInstant } from '../src/scheduling/time';

const WARSAW = 'Europe/Warsaw';
const h = (hours: number, minutes = 0) => hours * 60 + minutes;

function schedule(
  weekly: Record<number, [number, number][]>,
  extra: Partial<StaffSchedule> = {},
): StaffSchedule {
  return {
    staffId: 'kasia',
    weekly: new Map(
      Object.entries(weekly).map(([day, intervals]) => [
        Number(day),
        intervals.map(([startMinute, endMinute]) => ({ startMinute, endMinute })),
      ]),
    ),
    overrides: new Map(),
    busy: [],
    ...extra,
  };
}

function query(date: string, extra: Partial<SlotQuery> = {}): SlotQuery {
  return {
    timeZone: WARSAW,
    from: date,
    to: date,
    durationMinutes: 60,
    bufferMinutes: 0,
    stepMinutes: 60,
    earliestStart: 0,
    latestStart: Number.POSITIVE_INFINITY,
    ...extra,
  };
}

const times = (instants: number[]) => instants.map((t) => instantToLocal(t, WARSAW).time);

describe('slot calculation', () => {
  it('offers start times only where the service and its buffer fit', () => {
    // Thursday 22.10.2026, 09:00–13:00 and 14:00–17:00 (lunch break), 45 min + 15 min buffer.
    const slots = staffSlots(
      schedule({
        4: [
          [h(9), h(13)],
          [h(14), h(17)],
        ],
      }),
      query('2026-10-22', { durationMinutes: 45, bufferMinutes: 15, stepMinutes: 15 }),
    );
    const t = times(slots);
    expect(t[0]).toBe('09:00');
    expect(t).toContain('12:00'); // 12:00 + 60 = 13:00, fits exactly
    expect(t).not.toContain('12:15'); // would run into the break
    expect(t).not.toContain('13:00'); // break
    expect(t).toContain('14:00');
    expect(t.at(-1)).toBe('16:00');
  });

  it('skips time off and other busy time, including the new service buffer', () => {
    const busy = [
      {
        start: zonedToInstant('2026-10-22', h(10), WARSAW),
        end: zonedToInstant('2026-10-22', h(11), WARSAW),
      },
    ];
    const t = times(
      staffSlots(
        schedule({ 4: [[h(9), h(13)]] }, { busy }),
        query('2026-10-22', { durationMinutes: 45, bufferMinutes: 15, stepMinutes: 15 }),
      ),
    );
    expect(t).toEqual(['09:00', '11:00', '11:15', '11:30', '11:45', '12:00']);
  });

  it('special hours replace the weekly template for that date only', () => {
    const s = schedule({ 4: [[h(9), h(12)]] });
    s.overrides.set('2026-10-22', [{ startMinute: h(15), endMinute: h(17) }]);
    const t = times(staffSlots(s, query('2026-10-22', { to: '2026-10-29' })));
    expect(t).toEqual(['15:00', '16:00', '09:00', '10:00', '11:00']); // 22.10 special, 29.10 normal
  });

  it('respects the earliest start (minimum lead time) and the horizon', () => {
    const s = schedule({ 4: [[h(9), h(13)]] });
    const t = times(
      staffSlots(
        s,
        query('2026-10-22', {
          earliestStart: zonedToInstant('2026-10-22', h(10, 30), WARSAW),
          latestStart: zonedToInstant('2026-10-22', h(12), WARSAW),
        }),
      ),
    );
    expect(t).toEqual(['11:00']);
  });

  it('no working hours → no slots', () => {
    expect(staffSlots(schedule({}), query('2026-10-22'))).toEqual([]);
  });
});

describe('daylight saving time (Europe/Warsaw)', () => {
  it('29.03.2026: no slot in the skipped hour 02:00–03:00', () => {
    const t = times(staffSlots(schedule({ 7: [[h(0), h(6)]] }), query('2026-03-29')));
    expect(t).toEqual(['00:00', '01:00', '03:00', '04:00', '05:00']);
  });

  it('25.10.2026: the repeated hour 02:00 is offered once, never twice', () => {
    const t = times(staffSlots(schedule({ 7: [[h(0), h(6)]] }), query('2026-10-25')));
    expect(t).toEqual(['00:00', '01:00', '02:00', '03:00', '04:00', '05:00']);
    expect(new Set(t).size).toBe(t.length);
  });

  it('normal hours on transition days keep their wall-clock times', () => {
    const spring = staffSlots(schedule({ 7: [[h(9), h(11)]] }), query('2026-03-29'));
    expect(spring.map((t) => new Date(t).toISOString())).toEqual([
      '2026-03-29T07:00:00.000Z', // 09:00 CEST (+2)
      '2026-03-29T08:00:00.000Z',
    ]);
    const autumn = staffSlots(schedule({ 7: [[h(9), h(11)]] }), query('2026-10-25'));
    expect(autumn.map((t) => new Date(t).toISOString())).toEqual([
      '2026-10-25T08:00:00.000Z', // 09:00 CET (+1)
      '2026-10-25T09:00:00.000Z',
    ]);
  });
});

describe('"any staff member"', () => {
  it('merges slots and lists who is free at each time', () => {
    const kasia = schedule({ 4: [[h(9), h(11)]] });
    const ola = { ...schedule({ 4: [[h(10), h(12)]] }), staffId: 'ola' };
    const slots = mergeSlots([kasia, ola], query('2026-10-22'));
    expect(slots.map((s) => [s.time, s.staffIds])).toEqual([
      ['09:00', ['kasia']],
      ['10:00', ['kasia', 'ola']],
      ['11:00', ['ola']],
    ]);
    expect(slots[0]).toMatchObject({ date: '2026-10-22', start: '2026-10-22T07:00:00.000Z' });
  });
});
