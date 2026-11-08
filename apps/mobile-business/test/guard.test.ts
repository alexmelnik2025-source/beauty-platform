import { describe, expect, it } from 'vitest';
import type { CancellationGuard } from '../src/api';
import {
  actionLine,
  clientReasons,
  guardForm,
  guardRulesToSave,
  guardToSave,
  hasRule,
  mayManageGuard,
  ruleLines,
  type MarkedClient,
} from '../src/guard';
import { DICTIONARIES } from '../src/i18n';

const pl = DICTIONARIES.pl;

const settings = (over: Partial<CancellationGuard> = {}): CancellationGuard => ({
  enabled: false,
  maxChanges: 3,
  windowHours: 720,
  lateCancelMinutes: 120,
  maxNoShows: 2,
  action: 'phone_only',
  version: 4,
  ...over,
});

describe('cancellation protection in the business app', () => {
  it('owners and managers only', () => {
    expect(mayManageGuard('owner')).toBe(true);
    expect(mayManageGuard('manager')).toBe(true);
    expect(mayManageGuard('staff')).toBe(false);
  });

  it('switching on needs a rule; everything else is sent back as it is', () => {
    expect(hasRule(settings())).toBe(true);
    expect(hasRule(settings({ maxChanges: null, lateCancelMinutes: null, maxNoShows: null }))).toBe(
      false,
    );
    expect(guardToSave(settings(), true)).toEqual({ ...settings(), enabled: true });
  });

  it('one line per rule that is set, days when the window is whole days', () => {
    expect(ruleLines(settings(), pl)).toEqual([
      'Odwołania lub przeniesienia: 3 w ciągu 30 dni',
      'Odwołanie później niż 120 min przed wizytą',
      'Nieobecności: 2',
    ]);
    expect(
      ruleLines(settings({ windowHours: 36, lateCancelMinutes: null, maxNoShows: null }), pl),
    ).toEqual(['Odwołania lub przeniesienia: 3 w ciągu 36 godz.']);
    expect(actionLine('approval', pl)).toBe(
      'Co wtedy: Rezerwacja online tylko z potwierdzeniem salonu',
    );
  });

  it('why a client is marked, with what the missed visits cost', () => {
    const client: MarkedClient = {
      customerId: 'c1',
      name: 'Jan Kowalski',
      phone: '+48600100200',
      email: null,
      reasons: ['no_shows'],
      changes: 1,
      lateCancellations: 0,
      noShows: 2,
      noShowAmountGrosze: 18000,
      releasedAt: null,
    };
    expect(clientReasons(client, 'PLN', pl, 'pl')).toMatch(
      /^nieobecności: 2 · Nieodbyte wizyty: 180,00\s?zł$/,
    );
  });

  it('the action names exist in every language', () => {
    for (const t of Object.values(DICTIONARIES)) {
      for (const action of ['approval', 'phone_only', 'prepay'] as const) {
        expect(actionLine(action, t)).not.toContain('{action}');
      }
    }
  });
});

describe('changing the protection rules (task 349)', () => {
  it('gives the form back with defaults for rules never set', () => {
    expect(guardForm(settings())).toEqual({
      changesOn: true,
      changes: '3',
      windowDays: '30',
      lateOn: true,
      lateMinutes: '120',
      noShowsOn: true,
      noShows: '2',
      action: 'phone_only',
    });
    expect(
      guardForm(settings({ maxChanges: null, lateCancelMinutes: null, maxNoShows: null })),
    ).toMatchObject({ changesOn: false, changes: '3', lateOn: false, noShowsOn: false });
  });

  it('saves the whole settings; switched-off rules become null', () => {
    const form = {
      ...guardForm(settings()),
      lateOn: false,
      windowDays: '14',
      action: 'prepay' as const,
    };
    expect(guardRulesToSave(settings(), form)).toEqual({
      ok: true,
      save: settings({ lateCancelMinutes: null, windowHours: 14 * 24, action: 'prepay' }),
    });
  });

  it('keeps a period saved in hours when the days are not changed', () => {
    const s = settings({ windowHours: 36 });
    expect(guardRulesToSave(s, guardForm(s))).toMatchObject({
      ok: true,
      save: { windowHours: 36 },
    });
  });

  it('points out the wrong number and a protection without rules', () => {
    const form = guardForm(settings());
    expect(guardRulesToSave(settings(), { ...form, changes: '51' })).toEqual({
      ok: false,
      problem: 'changes',
    });
    expect(guardRulesToSave(settings(), { ...form, windowDays: '0' })).toMatchObject({
      problem: 'windowDays',
    });
    expect(guardRulesToSave(settings(), { ...form, lateMinutes: '1,5' })).toMatchObject({
      problem: 'lateMinutes',
    });
    expect(guardRulesToSave(settings(), { ...form, noShows: '21' })).toMatchObject({
      problem: 'noShows',
    });
    // A switched-off rule is not checked.
    expect(guardRulesToSave(settings(), { ...form, noShowsOn: false, noShows: 'x' })).toMatchObject(
      { ok: true },
    );
    const none = { ...form, changesOn: false, lateOn: false, noShowsOn: false };
    expect(guardRulesToSave(settings({ enabled: true }), none)).toEqual({
      ok: false,
      problem: 'needRule',
    });
    expect(guardRulesToSave(settings(), none)).toMatchObject({ ok: true });
    for (const dict of Object.values(DICTIONARIES)) {
      expect(Object.keys(dict.guard.problem).sort()).toEqual([
        'changes',
        'lateMinutes',
        'needRule',
        'noShows',
        'windowDays',
      ]);
    }
  });
});
