import { describe, expect, it } from 'vitest';
import { CURRENCIES, currencyName, matching, salonTimeZones, timeZoneLabel } from '../src/country';

describe('salonTimeZones (task 323)', () => {
  it('puts Poland first and names the country in the reader’s language', () => {
    const zones = salonTimeZones('pl');
    expect(zones[0]).toEqual({ timeZone: 'Europe/Warsaw', label: 'Polska (Warsaw)' });
    expect(zones.map((z) => z.timeZone)).toContain('Europe/Kiev');
    expect(zones.map((z) => z.timeZone)).not.toContain('Europe/Kyiv');
    expect(zones.find((z) => z.timeZone === 'Europe/Kiev')?.label).toBe('Ukraina (Kyiv)');
    expect(salonTimeZones('uk').find((z) => z.timeZone === 'Europe/Prague')?.label).toBe(
      'Чехія (Prague)',
    );
  });

  it('keeps a zone the salon already has even when it is not on the list', () => {
    expect(salonTimeZones('en', 'America/New_York').map((z) => z.timeZone)).toContain(
      'America/New_York',
    );
    expect(timeZoneLabel('America/New_York', 'en')).toBe('America/New_York');
  });
});

describe('currencyName', () => {
  it('shows the code with its name', () => {
    expect(currencyName('EUR', 'en')).toBe('EUR — Euro');
    expect(CURRENCIES[0]).toBe('PLN');
    expect(CURRENCIES).toContain('UAH');
  });
});

describe('matching', () => {
  it('finds by a few letters, ignoring case and accents', () => {
    const items = salonTimeZones('pl');
    expect(matching(items, 'czech').map((z) => z.timeZone)).toEqual(['Europe/Prague']);
    expect(matching(items, 'WEGRY').map((z) => z.timeZone)).toEqual(['Europe/Budapest']);
    expect(matching(items, '  ')).toHaveLength(items.length);
    expect(matching(items, 'xyz')).toEqual([]);
  });
});
