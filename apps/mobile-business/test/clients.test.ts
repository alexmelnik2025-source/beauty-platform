import { describe, expect, it } from 'vitest';
import {
  BusinessApi,
  type LoyaltyAccount,
  type PermissionCatalog,
  type TokenStore,
} from '../src/api';
import {
  birthdayText,
  bonusSummary,
  canEditNotes,
  completedCount,
  parseBirthday,
  dateIn,
  parseTags,
  splitVisits,
  suggestTags,
  addTag,
  visitWhen,
} from '../src/clients';

type Me = PermissionCatalog['me'];
const staff = (permissions: Partial<Me['permissions']>): Me =>
  ({ role: 'staff', permissions }) as Me;

describe('client card helpers', () => {
  it('reads the typed day and month of a birthday (task 241)', () => {
    expect(parseBirthday('15', '3')).toBe('03-15');
    expect(parseBirthday(' 1 ', '12')).toBe('12-01');
    expect(parseBirthday('29', '2')).toBe('02-29');
    expect(parseBirthday('', '')).toBeNull();
    for (const [d, m] of [
      ['30', '2'],
      ['31', '4'],
      ['15', ''],
      ['', '3'],
      ['0', '3'],
      ['15', '13'],
      ['a', '3'],
    ] as const) {
      expect(parseBirthday(d, m)).toBeUndefined();
    }
  });

  it('shows a birthday as day and month, or "today" in the salon\'s time zone (task 240)', () => {
    // 23:30 UTC on 14 March is already 15 March in Warsaw.
    const now = new Date('2027-03-14T23:30:00Z');
    expect(birthdayText('03-15', 'pl', 'dziś', 'Europe/Warsaw', now)).toBe('dziś');
    expect(birthdayText('03-14', 'pl', 'dziś', 'Europe/Warsaw', now)).toBe('14 marca');
    expect(birthdayText('03-15', 'en', 'today', 'UTC', now)).toBe('15 March');
    expect(birthdayText('02-29', 'pl', 'dziś', 'Europe/Warsaw', now)).toBe('29 lutego');
  });

  it('owners and managers edit notes; a specialist needs to see and to edit them', () => {
    expect(canEditNotes({ role: 'owner', permissions: {} } as Me)).toBe(true);
    expect(canEditNotes({ role: 'manager', permissions: {} } as Me)).toBe(true);
    expect(canEditNotes(staff({ viewClientNotes: true, editClientNotes: true }))).toBe(true);
    expect(canEditNotes(staff({ viewClientNotes: true, editClientNotes: false }))).toBe(false);
    expect(canEditNotes(staff({ viewClientNotes: false, editClientNotes: true }))).toBe(false);
  });

  it('reads tags typed with commas: trimmed, no empty ones, no repeats, at most 10', () => {
    expect(parseTags(' vip, stały klient ,, vip ,broda')).toEqual(['vip', 'stały klient', 'broda']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags('x'.repeat(40))).toEqual(['x'.repeat(30)]);
    expect(parseTags(Array.from({ length: 12 }, (_, i) => `t${i}`).join(','))).toHaveLength(10);
  });

  it("offers the salon's labels the client does not have yet and adds one (task 226)", () => {
    const known = ['stały klient', 'broda', 'kosmetyki'];
    expect(suggestTags('', known)).toEqual(known);
    expect(suggestTags('Broda, vip', known)).toEqual(['stały klient', 'kosmetyki']);
    expect(suggestTags('', known, 2)).toEqual(['stały klient', 'broda']);
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}`).join(', ');
    expect(suggestTags(ten, known)).toEqual([]);
    expect(addTag('', 'broda')).toBe('broda');
    expect(addTag(' vip ,', 'broda')).toBe('vip, broda');
    expect(addTag(ten, 'broda')).toBe(ten);
  });

  it('upcoming visits of this salon soonest first, the rest newest first', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const visit = (id: string, start: string, status: string, locationId = 'l1') => ({
      id,
      locationId,
      start,
      status: status as 'confirmed',
      serviceName: 'Strzyżenie',
      staffName: 'Kasia',
    });
    const visits = [
      visit('past1', '2026-10-01T10:00:00Z', 'completed'),
      visit('soon2', '2026-11-20T10:00:00Z', 'confirmed'),
      visit('soon1', '2026-11-05T10:00:00Z', 'confirmed'),
      visit('cancelled', '2026-11-10T10:00:00Z', 'cancelled'),
      visit('past2', '2026-10-20T10:00:00Z', 'no_show'),
      visit('other', '2026-11-06T10:00:00Z', 'confirmed', 'l2'),
      visit('past3', '2026-09-01T10:00:00Z', 'completed'),
    ];
    const { upcoming, past } = splitVisits(visits, 'l1', now);
    expect(upcoming.map((v) => v.id)).toEqual(['soon1', 'soon2']);
    expect(past.map((v) => v.id)).toEqual(['cancelled', 'past2', 'past1', 'past3']);
    expect(completedCount(visits, 'l1')).toBe(2);
    expect(completedCount(visits, 'l2')).toBe(0);
  });

  it("shows the visit time in the salon's time zone", () => {
    expect(visitWhen('2026-11-12T13:30:00Z', 'Europe/Warsaw', 'pl')).toBe('12.11.2026, 14:30');
    expect(visitWhen('2026-07-01T23:30:00Z', 'Europe/Warsaw', 'en')).toBe('02/07/2026, 01:30');
  });
});

describe('BusinessApi clients', () => {
  it('searches clients, reads a card and saves the note and tags with the version it read', async () => {
    const calls: { key: string; body: unknown; auth?: string }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        key,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: headers.authorization,
      });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a9', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : key.includes('?')
          ? []
          : { id: 'c1', version: 3 };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.customers('o1', ' Anna Kow ');
    await api.customers('o1', '', 20);
    await api.customers('o1', '', 50, 90);
    await api.customers('o1', '', 50, 0, 'stały klient');
    await api.customerTags('o1');
    await api.customer('o1', 'c1');
    await api.updateCustomerNotes('o1', 'c1', 2, 'Lubi krótko', ['vip']);
    await api.updateCustomerNotes('o1', 'c1', 3, null, []);
    await api.loyaltyAccount('o1', 'c1');
    expect(calls.slice(1).map((c) => [c.key, c.body, c.auth])).toEqual([
      ['GET /v1/organizations/o1/customers?limit=50&search=Anna+Kow', undefined, 'Bearer a9'],
      ['GET /v1/organizations/o1/customers?limit=20', undefined, 'Bearer a9'],
      // Task 140: "who hasn't been for a while".
      ['GET /v1/organizations/o1/customers?limit=50&inactiveDays=90', undefined, 'Bearer a9'],
      // Task 224: clients with one label, and the labels themselves.
      ['GET /v1/organizations/o1/customers?limit=50&tag=sta%C5%82y+klient', undefined, 'Bearer a9'],
      ['GET /v1/organizations/o1/customers/tags', undefined, 'Bearer a9'],
      ['GET /v1/organizations/o1/customers/c1', undefined, 'Bearer a9'],
      [
        'PATCH /v1/organizations/o1/customers/c1',
        { version: 2, note: 'Lubi krótko', tags: ['vip'] },
        'Bearer a9',
      ],
      [
        'PATCH /v1/organizations/o1/customers/c1',
        { version: 3, note: null, tags: [] },
        'Bearer a9',
      ],
      ['GET /v1/organizations/o1/loyalty/accounts/c1', undefined, 'Bearer a9'],
    ]);
  });
});

describe('bonus part of the client card', () => {
  const account = (over: Partial<LoyaltyAccount>): LoyaltyAccount => ({
    customer: { id: 'c1', name: 'Anna' },
    mode: 'stamps',
    balance: 0,
    lifetimeEarned: 0,
    transactions: [],
    coupons: [],
    tier: null,
    ...over,
  });
  const coupon = (id: string, status: string, expiresAt: string | null) =>
    ({
      id,
      status,
      expiresAt,
      name: '−20%',
      code: 'K7QM-4XTB',
    }) as LoyaltyAccount['coupons'][number];
  const now = new Date('2026-11-04T12:00:00Z');

  it('nothing in the program yet → no bonus part', () => {
    expect(bonusSummary(account({}), now)).toBeNull();
  });

  it('balance, tier with its discount and only usable coupons', () => {
    const summary = bonusSummary(
      account({
        mode: 'points',
        balance: 40,
        lifetimeEarned: 90,
        coupons: [
          coupon('a', 'active', '2026-12-31T22:59:59Z'),
          coupon('b', 'used', null),
          coupon('c', 'active', '2026-11-01T00:00:00Z'),
          coupon('d', 'active', null),
        ],
        tier: {
          basis: 'visits',
          periodDays: 365,
          value: 6,
          current: { name: 'Silver', discountPercent: 5 },
          next: null,
        },
      }),
      now,
    );
    expect(summary).toMatchObject({ mode: 'points', balance: 40, tier: 'Silver · −5%' });
    expect(summary!.coupons.map((c) => c.id)).toEqual(['a', 'd']);
    expect(dateIn('2026-12-31T22:59:59Z', 'Europe/Warsaw', 'pl')).toBe('31.12.2026');
  });

  it('a tier without a discount is shown by its name; spent stamps still count', () => {
    const summary = bonusSummary(
      account({
        lifetimeEarned: 10,
        tier: {
          basis: 'spend',
          periodDays: 365,
          value: 0,
          current: { name: 'Standard', discountPercent: 0 },
          next: null,
        },
      }),
      now,
    );
    expect(summary).toMatchObject({ mode: 'stamps', balance: 0, tier: 'Standard' });
  });
});
