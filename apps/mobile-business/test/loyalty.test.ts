import { describe, expect, it } from 'vitest';
import type { LoyaltyProgram, LoyaltyReward, LoyaltyTransaction } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import {
  costText,
  EMPTY_REWARD,
  mayManageLoyalty,
  newReward,
  operationLine,
  operationTitle,
  programRule,
  programToSave,
  rewardLabel,
  rulesForm,
  rulesToSave,
  sortedRewards,
} from '../src/loyalty';

const pl = DICTIONARIES.pl;

const program = (over: Partial<LoyaltyProgram> = {}): LoyaltyProgram => ({
  enabled: false,
  mode: 'stamps',
  stampsPerVisit: 1,
  pointsPerUnit: 10,
  spendUnitGrosze: 5000,
  minSpendGrosze: 0,
  pointsValidityDays: null,
  maxDiscountPercent: 50,
  allowStacking: false,
  marketplaceEnabled: false,
  earnRules: [{ serviceId: 's1', serviceName: 'Broda', locationId: 'l1', points: 2 }],
  version: 3,
  ...over,
});

const reward = (id: string, over: Partial<LoyaltyReward> = {}): LoyaltyReward => ({
  id,
  name: id,
  kind: 'discount_percent',
  discountPercent: 25,
  freeServiceId: null,
  cost: 5,
  serviceIds: [],
  couponValidityDays: null,
  sortOrder: 0,
  archivedAt: null,
  version: 1,
  ...over,
});

describe('who manages the program', () => {
  it('owners and managers, never staff', () => {
    expect(mayManageLoyalty('owner')).toBe(true);
    expect(mayManageLoyalty('manager')).toBe(true);
    expect(mayManageLoyalty('staff')).toBe(false);
  });
});

describe('programToSave', () => {
  it('sends every setting back as it is, with the version, only switched', () => {
    const saved = programToSave(program(), true);
    expect(saved).toEqual({
      version: 3,
      enabled: true,
      mode: 'stamps',
      stampsPerVisit: 1,
      pointsPerUnit: 10,
      spendUnitGrosze: 5000,
      minSpendGrosze: 0,
      pointsValidityDays: null,
      maxDiscountPercent: 50,
      allowStacking: false,
      marketplaceEnabled: false,
    });
    expect('earnRules' in saved).toBe(false);
  });
});

describe('texts', () => {
  it('the rule of a stamp card and of points in the salon currency', () => {
    expect(programRule(program(), pl, 'pl', 'PLN')).toBe('Karta pieczątek: 1 za opłaconą wizytę');
    expect(programRule(program({ mode: 'points' }), DICTIONARIES.en, 'en', 'EUR')).toBe(
      'Points: 10 for every €50.00',
    );
  });

  it('a discount, a free service by name, a service of another salon', () => {
    const names = new Map([['svc', 'Strzyżenie']]);
    expect(rewardLabel(reward('a'), names, pl)).toBe('Zniżka 25%');
    expect(
      rewardLabel(
        reward('b', { kind: 'free_service', discountPercent: null, freeServiceId: 'svc' }),
        names,
        pl,
      ),
    ).toBe('Gratis: Strzyżenie');
    expect(
      rewardLabel(
        reward('c', { kind: 'free_service', discountPercent: null, freeServiceId: 'x' }),
        names,
        pl,
      ),
    ).toBe('Gratis: usługa innego salonu');
    expect(costText(5, 'stamps', pl)).toBe('pieczątki: 5');
    expect(costText(100, 'points', pl)).toBe('pkt: 100');
  });

  it('removed rewards are left out, the rest by order and price', () => {
    const list = sortedRewards([
      reward('dear', { cost: 10 }),
      reward('gone', { archivedAt: '2026-11-01T10:00:00Z' }),
      reward('cheap', { cost: 3 }),
      reward('first', { cost: 50, sortOrder: -1 }),
    ]);
    expect(list.map((r) => r.id)).toEqual(['first', 'cheap', 'dear']);
  });

  it('an operation: type, client, signed points, balance and salon time', () => {
    const entry: LoyaltyTransaction = {
      id: 't1',
      customer: { id: 'c1', name: 'Jan Kowalski' },
      type: 'earn',
      points: 1,
      balanceAfter: 3,
      appointmentId: 'a1',
      reversesId: null,
      expiresAt: null,
      actorUserId: null,
      note: null,
      createdAt: '2026-11-05T13:05:00.000Z',
    };
    expect(operationTitle(entry, pl)).toBe('Naliczenie za wizytę · Jan Kowalski');
    expect(operationLine(entry, pl, 'pl', 'Europe/Warsaw')).toMatch(
      /^\+1 · saldo: 3 · 5 lis 2026.*14:05$/,
    );
    expect(operationLine({ ...entry, type: 'redeem', points: -5 }, pl, 'pl', 'UTC')).toMatch(
      /^-5 · saldo: 3 · 5 lis 2026.*13:05$/,
    );
  });
});

describe('newReward', () => {
  it('a discount needs a name, 1–100% and a price', () => {
    expect(newReward({ ...EMPTY_REWARD, percent: '25', cost: '5' })).toEqual({
      ok: false,
      problem: 'name',
    });
    expect(newReward({ ...EMPTY_REWARD, name: '−25%', percent: '0', cost: '5' })).toEqual({
      ok: false,
      problem: 'percent',
    });
    expect(newReward({ ...EMPTY_REWARD, name: '−25%', percent: '25', cost: '' })).toEqual({
      ok: false,
      problem: 'cost',
    });
    expect(newReward({ ...EMPTY_REWARD, name: ' −25% ', percent: '25%', cost: '5' })).toEqual({
      ok: true,
      reward: {
        name: '−25%',
        kind: 'discount_percent',
        discountPercent: 25,
        freeServiceId: null,
        cost: 5,
      },
    });
  });

  it('a free service needs the service, not a percent', () => {
    const form = {
      ...EMPTY_REWARD,
      name: 'Broda gratis',
      kind: 'free_service' as const,
      cost: '8',
    };
    expect(newReward(form)).toEqual({ ok: false, problem: 'service' });
    expect(newReward({ ...form, serviceId: 'svc', percent: '30' })).toEqual({
      ok: true,
      reward: {
        name: 'Broda gratis',
        kind: 'free_service',
        discountPercent: null,
        freeServiceId: 'svc',
        cost: 8,
      },
    });
  });
});

describe('program rules (task 344)', () => {
  it('shows the saved rules as typed amounts', () => {
    expect(
      rulesForm(program({ spendUnitGrosze: 5050, minSpendGrosze: 3000, pointsValidityDays: 365 })),
    ).toEqual({
      mode: 'stamps',
      stampsPerVisit: '1',
      pointsPerUnit: '10',
      spendUnit: '50,50',
      minSpend: '30',
      validityDays: '365',
      maxDiscountPercent: '50',
      allowStacking: false,
    });
  });

  it('turns a points program into the whole settings, the switch and version as read', () => {
    const p = program({ enabled: true });
    const checked = rulesToSave(p, {
      ...rulesForm(p),
      mode: 'points',
      pointsPerUnit: '5',
      spendUnit: '10,5',
      minSpend: '',
      validityDays: '180',
      maxDiscountPercent: '30',
      allowStacking: true,
    });
    expect(checked).toEqual({
      ok: true,
      save: {
        ...programToSave(p, true),
        mode: 'points',
        pointsPerUnit: 5,
        spendUnitGrosze: 1050,
        minSpendGrosze: 0,
        pointsValidityDays: 180,
        maxDiscountPercent: 30,
        allowStacking: true,
      },
    });
  });

  it('empty validity = no limit; stamps keep the points fields as saved', () => {
    const p = program({ pointsValidityDays: 90 });
    const points = rulesToSave(p, { ...rulesForm(p), mode: 'points', validityDays: ' ' });
    expect(points.ok && points.save.pointsValidityDays).toBeNull();
    const stamps = rulesToSave(p, { ...rulesForm(p), stampsPerVisit: '2', validityDays: 'x' });
    expect(stamps.ok && stamps.save).toMatchObject({ stampsPerVisit: 2, pointsValidityDays: 90 });
  });

  it('points out what is wrong', () => {
    const p = program();
    const form = rulesForm(p);
    const problem = (over: Partial<typeof form>) => {
      const r = rulesToSave(p, { ...form, ...over });
      return r.ok ? null : r.problem;
    };
    expect(problem({ stampsPerVisit: '101' })).toBe('stampsPerVisit');
    expect(problem({ stampsPerVisit: '1.5' })).toBe('stampsPerVisit');
    expect(problem({ mode: 'points', pointsPerUnit: '' })).toBe('pointsPerUnit');
    expect(problem({ mode: 'points', spendUnit: '0' })).toBe('spendUnit');
    expect(problem({ mode: 'points', validityDays: '0' })).toBe('validityDays');
    expect(problem({ minSpend: 'abc' })).toBe('minSpend');
    expect(problem({ maxDiscountPercent: '101' })).toBe('maxDiscountPercent');
    expect(problem({})).toBeNull();
  });
});
