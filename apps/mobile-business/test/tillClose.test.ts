import { describe, expect, it } from 'vitest';
import type { TillClose } from '../src/api';
import {
  cashInput,
  changedSinceClose,
  expectedParts,
  movementReady,
  parseCash,
  signed,
  tillDifference,
} from '../src/tillClose';

const closed = (counted: number, expected: number, now = expected): TillClose => ({
  date: '2026-11-06',
  currency: 'PLN',
  expectedCashGrosze: now,
  visitsCashGrosze: now,
  cashInGrosze: 0,
  cashOutGrosze: 0,
  movements: [],
  close: {
    countedCashGrosze: counted,
    expectedCashGrosze: expected,
    differenceGrosze: counted - expected,
    note: null,
    closedByName: 'Anna',
    closedAt: '2026-11-06T19:00:00.000Z',
  },
});

describe('"Zamknij kasę" (task 232)', () => {
  it('says whether the counted cash matches, misses or is too much', () => {
    expect(tillDifference(closed(9000, 9000).close!)).toEqual({ kind: 'matches' });
    expect(tillDifference(closed(8000, 9000).close!)).toEqual({ kind: 'missing', grosze: 1000 });
    expect(tillDifference(closed(9550, 9000).close!)).toEqual({ kind: 'surplus', grosze: 550 });
  });

  it('notices cash payments that changed after the till was counted', () => {
    expect(changedSinceClose(closed(9000, 9000))).toBe(false);
    expect(changedSinceClose(closed(9000, 9000, 18000))).toBe(true);
    expect(changedSinceClose({ ...closed(0, 0), close: null })).toBe(false);
  });

  it('reads the counted amount; empty is not an amount', () => {
    expect(parseCash('150')).toBe(15000);
    expect(parseCash(' 150,5 ')).toBe(15050);
    expect(parseCash('0')).toBe(0);
    for (const text of ['', '-5', '15,555', 'abc', '80x', '1000001']) {
      expect(parseCash(text)).toBeNull();
    }
    expect(cashInput(15000)).toBe('150');
    expect(cashInput(15005)).toBe('150,05');
    expect(parseCash(cashInput(15005))).toBe(15005);
  });

  it('writes a difference with its sign (task 235)', () => {
    const zl = (n: number) => `${(n / 100).toFixed(2)} zł`;
    expect(signed(1000, zl)).toBe('+10.00 zł');
    expect(signed(-550, zl)).toBe('−5.50 zł');
    expect(signed(0, zl)).toBe('0.00 zł');
  });
});

describe('"Wpłata / wypłata" (task 236)', () => {
  it('shows the parts of what should be in the till once cash was put in or taken out', () => {
    const view = closed(9000, 9000);
    expect(expectedParts(view)).toEqual({ kind: 'visits', visits: 9000 });
    const moved: TillClose = {
      ...view,
      expectedCashGrosze: 13_000,
      cashInGrosze: 5000,
      cashOutGrosze: 1000,
      movements: [
        {
          id: 'm1',
          kind: 'in',
          amountGrosze: 5000,
          note: 'Reszta',
          createdByName: 'Anna',
          createdAt: '2026-11-06T08:00:00.000Z',
        },
        {
          id: 'm2',
          kind: 'out',
          amountGrosze: 1000,
          note: 'Ręczniki',
          createdByName: 'Anna',
          createdAt: '2026-11-06T12:00:00.000Z',
        },
      ],
    };
    expect(expectedParts(moved)).toEqual({
      kind: 'withMovements',
      total: 13_000,
      visits: 9000,
      cashIn: 5000,
      cashOut: 1000,
    });
    expect(changedSinceClose(moved)).toBe(true);
  });

  it('needs an amount above zero and a reason', () => {
    expect(movementReady(parseCash('10'), 'Ręczniki')).toBe(true);
    expect(movementReady(parseCash('0'), 'Ręczniki')).toBe(false);
    expect(movementReady(parseCash('10x'), 'Ręczniki')).toBe(false);
    expect(movementReady(parseCash('10'), '  ')).toBe(false);
  });
});
