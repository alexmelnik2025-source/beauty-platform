import { describe, expect, it } from 'vitest';
import { APPOINTMENT_EVENT_TYPES } from '../src/booking/appointment-writer';
import { en } from '../../web/lib/i18n/en';
import { pl } from '../../web/lib/i18n/pl';
import { ru } from '../../web/lib/i18n/ru';
import { sq } from '../../web/lib/i18n/sq';
import { tr } from '../../web/lib/i18n/tr';
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
    expect(leafPaths(tr)).toEqual(reference);
    expect(leafPaths(sq)).toEqual(reference);
  });

  it('Turkish and Albanian translate everything a client sees (L5, part 4)', () => {
    const clientSide = ['common', 'booking', 'manage', 'visits', 'bonuses', 'install'] as const;
    for (const dict of [tr, sq]) {
      for (const section of clientSide) {
        const theirs = dict[section] as Record<string, string>;
        const english = en[section] as Record<string, string>;
        for (const key of Object.keys(english)) {
          // Words that are the same in every language (SMS, Email in Albanian).
          if (['SMS', 'Email', 'min'].includes(english[key]!)) continue;
          expect(theirs[key], `${dict.langName}: ${section}.${key}`).not.toBe(english[key]);
        }
      }
      expect(dict.appointment.status.confirmed).not.toBe(en.appointment.status.confirmed);
      expect(dict.legal.acceptTerms).not.toBe(en.legal.acceptTerms);
    }
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

describe('calendar errors in the salon app', () => {
  it('a taken time says the specialist already has a visit then (owner test T10)', () => {
    expect(pl.errors.STAFF_BUSY).toBe('U tego specjalisty jest już wizyta w tym czasie.');
    for (const dict of [uk, ru, en])
      expect(dict.errors.STAFF_BUSY).not.toBe(dict.errors.SLOT_TAKEN);
  });
});
