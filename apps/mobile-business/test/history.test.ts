import { describe, expect, it } from 'vitest';
import type { AuditLog } from '../src/api';
import { appendPage, historyLine, historyTitle, mayViewHistory } from '../src/history';
import { DICTIONARIES } from '../src/i18n';

type Entry = AuditLog['items'][number];

const entry = (id: string, patch: Partial<Entry> = {}): Entry => ({
  id,
  at: '2026-11-05T13:05:00.000Z',
  action: 'service.updated',
  entityType: 'service',
  entityId: 'svc-1',
  entityName: 'Strzyżenie',
  actor: { id: 'u-1', name: 'Aleksander' },
  fields: ['priceGrosze'],
  date: null,
  ...patch,
});

describe('change log (task 150)', () => {
  const pl = DICTIONARIES.pl;

  it('is for the owner only', () => {
    expect(mayViewHistory('owner')).toBe(true);
    expect(mayViewHistory('manager')).toBe(false);
    expect(mayViewHistory('staff')).toBe(false);
  });

  it('names the change and what it was about', () => {
    expect(historyTitle(entry('1'), pl)).toBe('Zmieniono usługę: Strzyżenie');
    expect(historyTitle(entry('2', { entityName: null }), pl)).toBe('Zmieniono usługę');
    expect(historyTitle(entry('3', { action: 'something.new' }), pl)).toBe(
      'something.new: Strzyżenie',
    );
    expect(historyTitle(entry('4'), DICTIONARIES.en)).toMatch(/: Strzyżenie$/);
  });

  it('says who and when, in the salon’s time zone, and the day of a schedule change', () => {
    const line = historyLine(
      entry('1', { action: 'staff.override_set', date: '2026-11-07' }),
      pl,
      'pl',
      'Europe/Warsaw',
    );
    expect(line).toMatch(/^Aleksander · 5 lis 2026.*14:05 · dzień: (sob|so)/);
    expect(historyLine(entry('2', { actor: null }), pl, 'pl', 'Europe/Istanbul')).toMatch(
      /^System · .*16:05$/,
    );
  });

  it('adds an older page below without repeating entries', () => {
    const shown = [entry('3'), entry('2')];
    expect(appendPage(shown, [entry('2'), entry('1')]).map((e) => e.id)).toEqual(['3', '2', '1']);
  });

  it('has every action of the cabinet in all four languages', () => {
    const keys = Object.keys(pl.history.actions).sort();
    for (const d of Object.values(DICTIONARIES)) {
      expect(Object.keys(d.history.actions).sort()).toEqual(keys);
    }
  });
});
