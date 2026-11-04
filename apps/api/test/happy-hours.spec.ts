import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { happyHourPercent, visitPrice } from '../src/scheduling/happy-hours';
import { addDays, isoWeekday, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 16, part 1: the salon's happy hours set the price of new visits on the server. */

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let kasia: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let haircutId: string;
let beardId: string;
let kasiaId: string;
let olaId: string;
/** A day 3 days ahead: inside the booking horizon, beyond the lead time. */
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = (name: string, priceGrosze: number) =>
    ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name, durationMinutes: 30, bufferMinutes: 0, priceGrosze })
      .expect(201);
  haircutId = (await service('Strzyżenie', 8000)).body.id;
  beardId = (await service('Broda', 4999)).body.id;
  const ids: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [haircutId, beardId] })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${staff.body.id}/working-hours`)
      .set(owner.auth)
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      })
      .expect(200);
    ids.push(staff.body.id);
  }
  [kasiaId, olaId] = ids as [string, string];
  kasia = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: kasia.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

const put = (rules: object[], auth = owner.auth) =>
  ctx.http().put(`${base}/happy-hours`).set(auth).send({ rules });

/** −20% at Kasia's on the test day, 10:00–14:00 (every service). */
const kasiaMornings = () => ({
  weekdays: [isoWeekday(day)],
  start: '10:00',
  end: '14:00',
  discountPercent: 20,
  staffIds: [kasiaId],
});

const booked = (staffId: string, start: string, serviceId = haircutId) =>
  ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId,
      staffId,
      start,
      customer: { name: 'Jan Nowak', phone: '+48600000002' },
    })
    .expect(201);

const row = (id: string) => ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });

describe('happy-hour price', () => {
  const rule = {
    weekdays: [1, 2, 3],
    startMinute: 600,
    endMinute: 840,
    discountPercent: 20,
    staffIds: [] as string[],
    serviceIds: [] as string[],
  };
  const visit = { staffId: 's1', serviceId: 'h', weekday: 1, minute: 600 };

  it('the largest rule that covers the weekday, start, staff member and service', () => {
    expect(happyHourPercent([rule], visit)).toBe(20);
    expect(happyHourPercent([rule], { ...visit, minute: 839 })).toBe(20);
    // The end is not included; nor are other days.
    expect(happyHourPercent([rule], { ...visit, minute: 840 })).toBeNull();
    expect(happyHourPercent([rule], { ...visit, weekday: 4 })).toBeNull();
    const kasiaOnly = { ...rule, discountPercent: 30, staffIds: ['s2'] };
    expect(happyHourPercent([rule, kasiaOnly], visit)).toBe(20);
    expect(happyHourPercent([rule, kasiaOnly], { ...visit, staffId: 's2' })).toBe(30);
    const beardOnly = { ...rule, discountPercent: 50, serviceIds: ['b'] };
    expect(happyHourPercent([beardOnly], visit)).toBeNull();
    expect(happyHourPercent([], visit)).toBeNull();
  });

  it('rounds the discount down to whole hundredths', () => {
    expect(visitPrice(4999, 20)).toEqual({
      priceGrosze: 4000,
      listPriceGrosze: 4999,
      happyHourPercent: 20,
    });
    expect(visitPrice(8000, null)).toEqual({
      priceGrosze: 8000,
      listPriceGrosze: null,
      happyHourPercent: null,
    });
    // A free service stays free, without a discount to show.
    expect(visitPrice(0, 20).listPriceGrosze).toBeNull();
  });
});

describe('happy hours of a salon', () => {
  it('the owner sets them; everyone in the salon reads them', async () => {
    const empty = await ctx.http().get(`${base}/happy-hours`).set(owner.auth).expect(200);
    expect(empty.body).toEqual({ rules: [] });
    const saved = await put([
      { ...kasiaMornings(), weekdays: [3, 1, 1] },
      { weekdays: [6], start: '16:00', end: '24:00', discountPercent: 10, serviceIds: [beardId] },
    ]).expect(200);
    expect(
      registeredResponseSchema('HappyHours').safeParse(saved.body).error?.issues ?? [],
    ).toEqual([]);
    expect(saved.body.rules).toEqual([
      {
        id: expect.any(String),
        weekdays: [1, 3],
        start: '10:00',
        end: '14:00',
        discountPercent: 20,
        staffIds: [kasiaId],
        serviceIds: [],
      },
      {
        id: expect.any(String),
        weekdays: [6],
        start: '16:00',
        end: '24:00',
        discountPercent: 10,
        staffIds: [],
        serviceIds: [beardId],
      },
    ]);
    const read = await ctx.http().get(`${base}/happy-hours`).set(kasia.auth).expect(200);
    expect(read.body).toEqual(saved.body);
    // An empty list turns them off.
    expect((await put([]).expect(200)).body).toEqual({ rules: [] });
  });

  it('refuses wrong rules, other salons’ staff and staff members', async () => {
    expectError(
      (await put([{ ...kasiaMornings(), start: '14:00', end: '10:00' }]).expect(400)).body,
      'VALIDATION_ERROR',
    );
    expectError(
      (await put([{ ...kasiaMornings(), discountPercent: 95 }]).expect(400)).body,
      'VALIDATION_ERROR',
    );
    expectError(
      (await put([{ ...kasiaMornings(), weekdays: [] }]).expect(400)).body,
      'VALIDATION_ERROR',
    );
    const other = await signUp(ctx, 'other@example.com');
    const theirs = await createOrgWithLocation(ctx, other, 'Inny');
    const theirStaff = await ctx
      .http()
      .post(`/v1/organizations/${theirs.orgId}/locations/${theirs.locationId}/staff`)
      .set(other.auth)
      .send({ displayName: 'Obcy' })
      .expect(201);
    expectError(
      (await put([{ ...kasiaMornings(), staffIds: [theirStaff.body.id] }]).expect(400)).body,
      'VALIDATION_ERROR',
    );
    await put([kasiaMornings()], kasia.auth).expect(403);
    expect((await ctx.http().get(`${base}/happy-hours`).set(owner.auth)).body.rules).toEqual([]);
  });
});

describe('the price of new visits', () => {
  it('a visit booked by the salon in happy hours costs less; others do not', async () => {
    await put([kasiaMornings()]).expect(200);
    const cheap = await booked(kasiaId, at(day, 10));
    expect(cheap.body.priceGrosze).toBe(6400);
    expect(await row(cheap.body.id)).toMatchObject({
      priceGrosze: 6400,
      listPriceGrosze: 8000,
      happyHourPercent: 20,
    });
    // Another staff member, the end of the hours, or before the rule: the usual price.
    expect((await booked(olaId, at(day, 10))).body.priceGrosze).toBe(8000);
    const after = await booked(kasiaId, at(day, 14));
    expect(await row(after.body.id)).toMatchObject({
      priceGrosze: 8000,
      listPriceGrosze: null,
      happyHourPercent: null,
    });
    // Changing the rules later does not change visits already booked.
    await put([]).expect(200);
    expect((await row(cheap.body.id)).priceGrosze).toBe(6400);
  });

  it('online: the hold shows the happy-hour price and the price before it', async () => {
    await put([kasiaMornings()]).expect(200);
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId: beardId, staffId: kasiaId, start: at(day, 11) })
      .expect(201);
    expect(registeredResponseSchema('Hold').safeParse(hold.body).error?.issues ?? []).toEqual([]);
    expect(hold.body).toMatchObject({
      priceGrosze: 4000,
      listPriceGrosze: 4999,
      happyHourPercent: 20,
    });
    const ola = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId: beardId, staffId: olaId, start: at(day, 12) })
      .expect(201);
    expect(ola.body).toMatchObject({
      priceGrosze: 4999,
      listPriceGrosze: null,
      happyHourPercent: null,
    });
  });
});

describe('happy hours in the free times', () => {
  const times = async (staffId?: string) =>
    (
      await ctx
        .http()
        .get(`/v1/public/locations/${slug}/availability`)
        .query({ serviceId: haircutId, from: day, to: day, ...(staffId ? { staffId } : {}) })
        .expect(200)
    ).body as {
      slots: { time: string; discountPercent: number | null }[];
    };
  const discountAt = (body: Awaited<ReturnType<typeof times>>, time: string) =>
    body.slots.find((s) => s.time === time)?.discountPercent;

  it('each free time says what it takes off', async () => {
    await put([kasiaMornings()]).expect(200);
    const atKasia = await times(kasiaId);
    expect(registeredResponseSchema('Availability').safeParse(atKasia).error?.issues ?? []).toEqual(
      [],
    );
    expect(discountAt(atKasia, '10:00')).toBe(20);
    expect(discountAt(atKasia, '13:30')).toBe(20);
    expect(discountAt(atKasia, '14:00')).toBeNull();
    expect(discountAt(atKasia, '09:00')).toBeNull();
    // "Any staff member": Ola has no happy hours, so nothing is promised.
    expect(discountAt(await times(), '10:00')).toBeNull();
    // Everyone −10%, Kasia −20%: "any staff member" gets at least 10%.
    await put([
      kasiaMornings(),
      { weekdays: [isoWeekday(day)], start: '10:00', end: '12:00', discountPercent: 10 },
    ]).expect(200);
    const any = await times();
    expect(discountAt(any, '10:00')).toBe(10);
    expect(discountAt(any, '12:00')).toBeNull();
    expect(discountAt(await times(olaId), '11:30')).toBe(10);
  });
});
