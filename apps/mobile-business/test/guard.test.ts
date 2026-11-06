import { describe, expect, it } from 'vitest';
import type { CancellationGuard } from '../src/api';
import {
  actionLine,
  clientReasons,
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
