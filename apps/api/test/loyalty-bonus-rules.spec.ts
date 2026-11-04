import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withBonus } from '../src/loyalty/loyalty-bonus';
import { addDays, isoWeekday, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LOCATION,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 19: extra stamps or points at chosen specialists and/or on chosen weekdays. */

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let haircutId: string;
let kasiaId: string;
let olaId: string;
let phone = 600_000_100;

const POINTS = {
  enabled: true,
  mode: 'points',
  stampsPerVisit: 1,
  pointsPerUnit: 10,
  spendUnitGrosze: 10_000,
  minSpendGrosze: 0,
  pointsValidityDays: null,
  maxDiscountPercent: 100,
  allowStacking: false,
  marketplaceEnabled: false,
} as const;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const created = await createOrgWithLocation(ctx, owner, 'Barber');
  orgId = created.orgId;
  locationId = created.locationId;
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  haircutId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 10_000 })
      .expect(201)
  ).body.id;
  const staff = async (displayName: string) =>
    (
      await ctx
        .http()
        .post(`${base}/staff`)
        .set(owner.auth)
        .send({ displayName, serviceIds: [haircutId] })
        .expect(201)
    ).body.id as string;
  kasiaId = await staff('Kasia');
  olaId = await staff('Ola');
  await saveProgram({});
});

const loyalty = () => `/v1/organizations/${orgId}/loyalty`;

async function saveProgram(changes: object): Promise<void> {
  const current = await ctx.http().get(`${loyalty()}/program`).set(owner.auth).expect(200);
  await ctx
    .http()
    .put(`${loyalty()}/program`)
    .set(owner.auth)
    .send({ ...POINTS, ...changes, version: current.body.version })
    .expect(200);
}

const putRules = (rules: object[], auth = owner.auth) =>
  ctx.http().put(`${loyalty()}/bonus-rules`).set(auth).send({ rules });

/** The last date before today (salon time) that falls on this ISO weekday. */
function lastWeekday(weekday: number): string {
  let day = addDays(localToday(Date.now(), TZ), -1);
  while (isoWeekday(day) !== weekday) day = addDays(day, -1);
  return day;
}

/** A paid visit at the specialist, on the local date and minute of the day; returns what it earned. */
async function paidVisit(
  staffId: string,
  date: string,
  minute = 10 * 60,
  paid = true,
): Promise<number> {
  const future = new Date(zonedToInstant(addDays(localToday(Date.now(), TZ), 2), 9 * 60, TZ));
  const booked = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId,
      start: future.toISOString(),
      allowOutsideHours: true,
      customer: { name: 'Jan Nowak', phone: `+48${phone}`, email: `jan${phone++}@example.com` },
    })
    .expect(201);
  const start = new Date(zonedToInstant(date, minute, TZ));
  await ctx.prisma.appointment.update({
    where: { id: booked.body.id },
    data: {
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60_000),
      blockedUntil: new Date(start.getTime() + 30 * 60_000),
    },
  });
  const came = await ctx
    .http()
    .post(`${base}/appointments/${booked.body.id}/status`)
    .set(owner.auth)
    .send({ version: booked.body.version, status: 'completed' })
    .expect(200);
  if (paid) {
    await ctx
      .http()
      .post(`${base}/appointments/${booked.body.id}/payment`)
      .set(owner.auth)
      .send({ version: came.body.version, paid: true })
      .expect(200);
  }
  const account = await ctx
    .http()
    .get(`${loyalty()}/accounts/${came.body.customer.id}`)
    .set(owner.auth)
    .expect(200);
  return account.body.balance;
}

describe('loyalty bonus rules', () => {
  it('the best matching rule wins; rules never add up; nothing extra on nothing', () => {
    const rules = [
      {
        name: 'Pn–śr',
        staffIds: [],
        weekdays: [1, 2, 3],
        multiplier: 2,
        extraPoints: 0,
        withinDays: null,
      },
      {
        name: 'Kasia',
        staffIds: ['k'],
        weekdays: [],
        multiplier: 1,
        extraPoints: 5,
        withinDays: null,
      },
      {
        name: 'Co 3 tygodnie',
        staffIds: [],
        weekdays: [],
        multiplier: 3,
        extraPoints: 0,
        withinDays: 21,
      },
    ];
    const at = (staffId: string, weekday: number, daysSincePrevious: number | null = null) => ({
      staffId,
      weekday,
      daysSincePrevious,
    });
    expect(withBonus(10, rules, at('k', 1))).toMatchObject({ points: 20, rule: { name: 'Pn–śr' } });
    expect(withBonus(2, rules, at('k', 1))).toMatchObject({ points: 7, rule: { name: 'Kasia' } });
    expect(withBonus(10, rules, at('o', 5))).toEqual({ points: 10, rule: null });
    expect(withBonus(0, rules, at('k', 1))).toEqual({ points: 0, rule: null });
    // Back within 21 days: ×3 wins; after 22 days or on a first visit it does not apply.
    expect(withBonus(10, rules, at('o', 5, 21))).toMatchObject({ points: 30 });
    expect(withBonus(10, rules, at('o', 5, 22))).toEqual({ points: 10, rule: null });
  });

  it('the owner sets them; checked on the server; staff members cannot', async () => {
    const empty = await ctx.http().get(`${loyalty()}/bonus-rules`).set(owner.auth).expect(200);
    expect(empty.body).toEqual({ rules: [] });

    const saved = await putRules([
      { name: 'Pn–śr u Kasi', staffIds: [kasiaId], weekdays: [3, 1, 2], multiplier: 2 },
      { name: 'Niedziela', weekdays: [7], extraPoints: 5 },
    ]).expect(200);
    expect(saved.body.rules).toMatchObject([
      {
        name: 'Pn–śr u Kasi',
        staff: [{ id: kasiaId, displayName: 'Kasia' }],
        weekdays: [1, 2, 3],
        multiplier: 2,
        extraPoints: 0,
        withinDays: null,
      },
      {
        name: 'Niedziela',
        staff: [],
        weekdays: [7],
        multiplier: 1,
        extraPoints: 5,
        withinDays: null,
      },
    ]);

    // A rule that gives nothing, a day that does not exist, the same day twice.
    await putRules([{ name: 'Nic', multiplier: 1, extraPoints: 0 }]).expect(400);
    await putRules([{ name: 'Zły dzień', weekdays: [8], multiplier: 2 }]).expect(400);
    await putRules([{ name: 'Dwa razy', weekdays: [1, 1], multiplier: 2 }]).expect(400);
    await putRules([{ name: 'Za długo', multiplier: 2, withinDays: 400 }]).expect(400);

    // A specialist of another salon.
    const other = await signUp(ctx, 'other@example.com');
    const otherSalon = await createOrgWithLocation(ctx, other, 'Other');
    const otherStaff = await ctx
      .http()
      .post(`/v1/organizations/${otherSalon.orgId}/locations/${otherSalon.locationId}/staff`)
      .set(other.auth)
      .send({ displayName: 'Obcy' })
      .expect(201);
    const foreign = await putRules([
      { name: 'Obcy', staffIds: [otherStaff.body.id], multiplier: 2 },
    ]).expect(404);
    expectError(foreign.body, 'NOT_FOUND');

    // A staff member may not see or change them.
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.http().get(`${loyalty()}/bonus-rules`).set(kasia.auth).expect(403);
    await putRules([], kasia.auth).expect(403);

    // An empty list switches them off.
    const off = await putRules([]).expect(200);
    expect(off.body.rules).toEqual([]);
  });

  it('a manager names only specialists of the locations they manage', async () => {
    const second = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({ ...LOCATION, name: 'Barber Wola' })
      .expect(201);
    const manager = await signUp(ctx, 'manager@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: manager.userId,
        organizationId: orgId,
        role: 'manager',
        locations: { create: [{ locationId: second.body.id }] },
      },
    });
    await putRules([{ name: 'Kasia', staffIds: [kasiaId], multiplier: 2 }], manager.auth).expect(
      404,
    );
    await putRules([{ name: 'Wszyscy', weekdays: [1], multiplier: 2 }], manager.auth).expect(200);
  });

  it('a paid visit earns by the rule of its specialist and weekday, in the salon time zone', async () => {
    await putRules([
      { name: 'Pn–śr u Kasi', staffIds: [kasiaId], weekdays: [1, 2, 3], multiplier: 2 },
      { name: '+3 w poniedziałek', weekdays: [1], extraPoints: 3 },
    ]).expect(200);
    const monday = lastWeekday(1);
    const friday = lastWeekday(5);

    // 100 zł × 10 points per 100 zł = 10 points by the general rule.
    expect(await paidVisit(kasiaId, monday)).toBe(20); // ×2 beats +3
    expect(await paidVisit(olaId, monday)).toBe(13); // not Kasia: only +3
    expect(await paidVisit(kasiaId, friday)).toBe(10); // no rule on Friday
    // 00:30 on Monday in Warsaw is still Sunday in UTC: the salon's day counts.
    expect(await paidVisit(olaId, monday, 30)).toBe(13);

    const history = await ctx.http().get(`${loyalty()}/transactions`).set(owner.auth).expect(200);
    const notes = history.body.map((t: { note: string | null }) => t.note);
    expect(notes).toContain('Pn–śr u Kasi: 10 → 20');
    expect(notes).toContain('+3 w poniedziałek: 10 → 13');
    expect(notes).toContain(null);
  });

  it('stamps are multiplied too; a visit that earns nothing stays at nothing', async () => {
    await saveProgram({ mode: 'stamps', stampsPerVisit: 1, minSpendGrosze: 20_000 });
    await putRules([{ name: 'Weekend', weekdays: [6, 7], multiplier: 3 }]).expect(200);
    // Below the minimum spend: no stamps, so no bonus either.
    expect(await paidVisit(kasiaId, lastWeekday(6))).toBe(0);
    await saveProgram({ mode: 'stamps', stampsPerVisit: 1, minSpendGrosze: 0 });
    expect(await paidVisit(kasiaId, lastWeekday(6))).toBe(3);
    expect(await paidVisit(kasiaId, lastWeekday(2))).toBe(1);
  });

  it('a client back within N days gets the rule; the previous visit must be paid', async () => {
    await putRules([{ name: 'Wróć w 3 tygodnie', multiplier: 2, withinDays: 21 }]).expect(200);
    const today = localToday(Date.now(), TZ);
    // The same client every time (the same phone number).
    const client = async (date: string, paid = true) => {
      phone = 600_000_999;
      return paidVisit(kasiaId, date, 10 * 60, paid);
    };
    expect(await client(addDays(today, -60))).toBe(10); // the first visit
    expect(await client(addDays(today, -30))).toBe(20); // 30 days later: no
    await client(addDays(today, -20), false); // came, but not paid: does not count
    expect(await client(addDays(today, -10))).toBe(40); // 20 days after the paid one: ×2
    expect(await client(addDays(today, -1))).toBe(60); // 9 days later: ×2 again
  });
});
