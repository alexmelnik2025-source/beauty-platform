import { describe, expect, it } from 'vitest';
import type { BaseIntegration, BaseSyncRun } from '../src/api';
import {
  agoText,
  baseCardState,
  baseErrorText,
  canSeeBase,
  lastSyncLine,
  runResultText,
} from '../src/baseStatus';
import { DICTIONARIES } from '../src/i18n';

const t = DICTIONARIES.pl;
const NOW = new Date('2026-11-20T05:00:00Z');

const status = (over: Partial<BaseIntegration> = {}): BaseIntegration => ({
  connected: true,
  tokenHint: 'a1b2',
  tokenReadable: true,
  inventoryId: '307',
  inventoryName: 'Sklep GESTALT',
  priceGroupId: '105',
  warehouseId: 'bl_201',
  lastImportAt: '2026-11-20T03:00:00Z',
  syncEveryMinutes: 60,
  lastSyncAt: '2026-11-20T04:48:00Z',
  lastErrorCode: null,
  importedProducts: 12,
  orders: {
    enabled: false,
    newStatusId: null,
    handedStatusId: null,
    cancelledStatusId: null,
    failing: 0,
  },
  ...over,
});

const run = (over: Partial<BaseSyncRun> = {}): BaseSyncRun => ({
  id: 'r1',
  trigger: 'manual',
  startedAt: '2026-11-20T05:00:00Z',
  finishedAt: '2026-11-20T05:00:01Z',
  checked: 12,
  changed: 2,
  missing: 0,
  errorCode: null,
  errorMessage: null,
  ...over,
});

describe('baseCardState (task Q4)', () => {
  it('no token: only the quiet line', () => {
    expect(baseCardState(status({ connected: false, tokenHint: null }))).toEqual({ kind: 'off' });
  });

  it('a token the server cannot read any more, or Base asking for it: paste again', () => {
    expect(baseCardState(status({ tokenReadable: false }))).toEqual({
      kind: 'fix',
      reason: 'reconnect',
    });
    expect(baseCardState(status({ lastErrorCode: 'BASE_RECONNECT' }))).toEqual({
      kind: 'fix',
      reason: 'reconnect',
    });
  });

  it('step 2 not done: choose the catalogue in the cabinet', () => {
    expect(baseCardState(status({ inventoryId: null }))).toEqual({
      kind: 'fix',
      reason: 'configure',
    });
  });

  it('working', () => {
    expect(baseCardState(status())).toEqual({ kind: 'on' });
  });
});

describe('agoText', () => {
  it('minutes, hours, days', () => {
    expect(agoText('2026-11-20T04:59:40Z', t, NOW)).toBe('przed chwilą');
    expect(agoText('2026-11-20T04:48:00Z', t, NOW)).toBe('12 min temu');
    expect(agoText('2026-11-20T02:00:00Z', t, NOW)).toBe('3 godz. temu');
    expect(agoText('2026-11-18T04:00:00Z', t, NOW)).toBe('2 dni temu');
  });

  it('a clock a little ahead does not give negative minutes', () => {
    expect(agoText('2026-11-20T05:01:00Z', t, NOW)).toBe('przed chwilą');
  });
});

describe('lastSyncLine', () => {
  it('when it went well', () => {
    expect(lastSyncLine(status(), t, NOW)).toBe('Ostatnia synchronizacja: 12 min temu.');
  });

  it('when it failed, with the reason in plain words', () => {
    expect(lastSyncLine(status({ lastErrorCode: 'BASE_UNREACHABLE' }), t, NOW)).toBe(
      'Ostatnia synchronizacja (12 min temu) nie udała się: Base nie odpowiada. Spróbuj za chwilę.',
    );
  });

  it('only the import so far, or nothing', () => {
    expect(lastSyncLine(status({ lastSyncAt: null }), t, NOW)).toBe(
      'Ostatnia synchronizacja: 2 godz. temu.',
    );
    expect(lastSyncLine(status({ lastSyncAt: null, lastImportAt: null }), t, NOW)).toBe(
      'Jeszcze nie synchronizowano.',
    );
  });
});

describe('runResultText', () => {
  it('what "Synchronizuj teraz" did', () => {
    expect(runResultText(run(), t)).toBe('Sprawdzono: 12 · zmieniono: 2');
    expect(runResultText(run({ missing: 1 }), t)).toBe(
      'Sprawdzono: 12 · zmieniono: 2 · brak w Base: 1 (stan 0)',
    );
  });

  it('a failed run says why', () => {
    expect(runResultText(run({ errorCode: 'BASE_TOKEN_INVALID' }), t)).toBe(
      'Base nie przyjmuje tokenu — wklej go ponownie w panelu.',
    );
  });
});

describe('baseErrorText', () => {
  it('known codes and the rest', () => {
    expect(baseErrorText('BASE_SYNC_TOO_SOON', t)).toMatch(/za minutę/);
    expect(baseErrorText('BASE_ERROR', t)).toMatch(/dzienniku/);
    expect(baseErrorText('SOMETHING_NEW', t)).toBe(baseErrorText('BASE_ERROR', t));
  });

  it('every language has the texts', () => {
    for (const d of Object.values(DICTIONARIES)) {
      expect(baseErrorText('BASE_UNREACHABLE', d)).not.toBe('');
      expect(d.shop.base.syncNow).not.toBe('');
    }
  });
});

describe('canSeeBase', () => {
  it('owners and managers only', () => {
    expect(canSeeBase('owner')).toBe(true);
    expect(canSeeBase('manager')).toBe(true);
    expect(canSeeBase('staff')).toBe(false);
  });
});
