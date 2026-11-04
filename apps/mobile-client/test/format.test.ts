import { describe, expect, it } from 'vitest';
import type { ClientAppointment } from '../src/api';
import { formatDay, formatPrice, groupByDay, salonAddress } from '../src/format';

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
