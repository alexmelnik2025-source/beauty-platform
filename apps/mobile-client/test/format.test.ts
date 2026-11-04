import { describe, expect, it } from 'vitest';
import type { ClientAppointment, Slot } from '../src/api';
import {
  dayChip,
  formatDay,
  formatMoment,
  formatPrice,
  groupByDay,
  salonAddress,
  slotsByDay,
  visitActions,
} from '../src/format';

const visit = (id: string, date: string): ClientAppointment =>
  ({ id, date, time: '10:00' }) as ClientAppointment;

describe('format', () => {
  it('names the salon-local day without shifting it by the phone’s time zone', () => {
    expect(formatDay('2026-11-10', 'pl')).toBe('wtorek, 10 listopada');
    expect(formatDay('2026-11-10', 'en')).toContain('Tuesday');
  });

  it('prices in the salon currency from hundredths', () => {
    expect(formatPrice(9000, 'PLN', 'pl').replace(/\s/g, ' ')).toBe('90,00 zł');
    expect(formatPrice(9000, 'EUR', 'en')).toBe('€90.00');
    expect(formatPrice(50000, 'TRY', 'pl').replace(/\s/g, ' ')).toBe('500,00 TRY');
  });

  it('address from the parts the salon filled in', () => {
    const salon = {
      name: 'Gestalt',
      slug: 'gestalt',
      addressLine: 'ul. Prosta 1',
      city: 'Warszawa',
      postalCode: '00-001',
      phone: null,
    };
    expect(salonAddress(salon)).toBe('ul. Prosta 1, Warszawa');
    expect(salonAddress({ ...salon, addressLine: ' ' })).toBe('Warszawa');
  });

  it('groups visits by day and keeps the order the API sent', () => {
    const groups = groupByDay([
      visit('a', '2026-11-12'),
      visit('b', '2026-11-12'),
      visit('c', '2026-11-10'),
    ]);
    expect(groups.map((g) => [g.date, g.items.map((i) => i.id)])).toEqual([
      ['2026-11-12', ['a', 'b']],
      ['2026-11-10', ['c']],
    ]);
    expect(groupByDay([])).toEqual([]);
  });
});

describe('visit card', () => {
  it('shows the change deadline in the salon’s time zone', () => {
    // 13:30 UTC = 14:30 in Warsaw (winter time).
    const text = formatMoment('2026-11-10T13:30:00.000Z', 'Europe/Warsaw', 'pl');
    expect(text).toContain('10 listopada');
    expect(text).toContain('14:30');
  });

  it('cancel only while the salon allows it; after the deadline — call the salon', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const base = { status: 'confirmed', canChange: true, end: future } as ClientAppointment;
    expect(visitActions(base)).toEqual({ cancel: true, move: true, tooLate: false });
    expect(visitActions({ ...base, canChange: false })).toEqual({
      cancel: false,
      move: false,
      tooLate: true,
    });
    expect(visitActions({ ...base, status: 'cancelled', canChange: false })).toEqual({
      cancel: false,
      move: false,
      tooLate: false,
    });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(visitActions({ ...base, status: 'completed', canChange: false, end: past })).toEqual({
      cancel: false,
      move: false,
      tooLate: false,
    });
  });
});

describe('change time', () => {
  const slot = (date: string, time: string, start: string): Slot =>
    ({ date, time, start, staffIds: ['k1'] }) as Slot;

  it('groups free times by day and leaves out the visit’s own time', () => {
    const slots = [
      slot('2026-11-10', '10:00', '2026-11-10T09:00:00.000Z'),
      slot('2026-11-10', '10:30', '2026-11-10T09:30:00.000Z'),
      slot('2026-11-12', '17:30', '2026-11-12T16:30:00.000Z'),
    ];
    const days = slotsByDay(slots, { start: '2026-11-10T09:00:00Z' });
    expect(days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-12']);
    expect(days[0]!.slots.map((s) => s.time)).toEqual(['10:30']);
    // The only free time of a day is the visit's own: that day is not offered.
    expect(slotsByDay([slots[0]!], { start: slots[0]!.start })).toEqual([]);
    expect(slotsByDay([])).toEqual([]);
  });

  it('day chips: short weekday and the day of the month, in the app language', () => {
    expect(dayChip('2026-11-10', 'pl')).toEqual({ weekday: 'wt.', day: '10' });
    expect(dayChip('2026-11-10', 'en').weekday).toBe('Tue');
    expect(dayChip('2026-11-01', 'en').day).toBe('1');
  });
});
