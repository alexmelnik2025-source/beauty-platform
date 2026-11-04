import { describe, expect, it } from 'vitest';
import type { ClientAppointment } from '../src/api';
import {
  formatDay,
  formatMoment,
  formatPrice,
  groupByDay,
  salonAddress,
  visitActions,
} from '../src/format';

const visit = (id: string, date: string): ClientAppointment =>
  ({ id, date, time: '10:00' }) as ClientAppointment;

describe('format', () => {
  it('names the salon-local day without shifting it by the phone’s time zone', () => {
    expect(formatDay('2026-11-10', 'pl')).toBe('wtorek, 10 listopada');
    expect(formatDay('2026-11-10', 'en')).toContain('Tuesday');
  });

  it('prices in złoty from grosze', () => {
    expect(formatPrice(9000, 'pl').replace(/\s/g, ' ')).toBe('90,00 zł');
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
    expect(visitActions(base)).toEqual({ cancel: true, tooLate: false });
    expect(visitActions({ ...base, canChange: false })).toEqual({ cancel: false, tooLate: true });
    expect(visitActions({ ...base, status: 'cancelled', canChange: false })).toEqual({
      cancel: false,
      tooLate: false,
    });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(visitActions({ ...base, status: 'completed', canChange: false, end: past })).toEqual({
      cancel: false,
      tooLate: false,
    });
  });
});
