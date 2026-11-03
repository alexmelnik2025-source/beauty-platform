import { describe, expect, it } from 'vitest';
import { APPOINTMENT_EVENT_TYPES } from '../src/booking/appointment-writer';
import { en } from '../../web/lib/i18n/en';
import { pl } from '../../web/lib/i18n/pl';
import { ru } from '../../web/lib/i18n/ru';
import { uk } from '../../web/lib/i18n/uk';

function leafPaths(value: object, prefix = ''): string[] {
  return Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return child && typeof child === 'object' ? leafPaths(child, path) : [path];
    })
    .sort();
}

describe('web translations', () => {
  it('keeps the same keys in Polish, Ukrainian, Russian and English', () => {
    const reference = leafPaths(pl);
    expect(leafPaths(uk)).toEqual(reference);
    expect(leafPaths(ru)).toEqual(reference);
    expect(leafPaths(en)).toEqual(reference);
  });
});

describe('visit history in the salon app', () => {
  it('has a translated label for every kind of history entry (no raw "paid")', () => {
    for (const dict of [pl, uk, ru, en]) {
      const labels = dict.appointment.events as Record<string, string>;
      for (const type of APPOINTMENT_EVENT_TYPES) {
        expect(labels[type], `${type}`).toBeTruthy();
        expect(labels[type]).not.toBe(type);
      }
    }
  });
});
