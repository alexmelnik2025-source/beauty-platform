import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { couponDiscount, normaliseCode } from '../src/loyalty/visit-coupons';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 10d, part 1: the client's loyalty coupon used on a visit, by the salon's rules. */

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let kasia: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let haircutId: string;
let beardId: string;
let kasiaStaffId: string;
let olaStaffId: string;
let hour = 8;

const POINTS = {
  enabled: true,
  mode: 'points',
  stampsPerVisit: 1,
  pointsPerUnit: 10,
  spendUnitGrosze: 10_000,
  minSpendGrosze: 0,
  pointsValidityDays: 365,
  maxDiscountPercent: 50,
  allowStacking: false,
  marketplaceEnabled: false,
} as const;

function expectShape(name: string, body: unknown): void {
  const result = registeredResponseSchema(name).safeParse(body);
  expect(result.error?.issues ?? [], `response does not match ${name}`).toEqual([]);
}

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  hour = 8;
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = (name: string, priceGrosze: number) =>
    ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name, durationMinutes: 30, priceGrosze })
      .expect(201);
  haircutId = (await service('Strzyżenie', 8000)).body.id;
  beardId = (await service('Broda', 4000)).body.id;
  const staffIds: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [haircutId, beardId] })
      .expect(201);
    staffIds.push(staff.body.id);
  }
  [kasiaStaffId, olaStaffId] = staffIds as [string, string];
  kasia = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: kasia.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
  await ctx.prisma.staffMember.update({
    where: { id: kasiaStaffId },
    data: { userId: kasia.userId },
  });
  const current = await ctx
    .http()
    .get(`/v1/organizations/${orgId}/loyalty/program`)
    .set(owner.auth)
    .expect(200);
  await saveProgram({ ...POINTS, version: current.body.version });
});

// ── Helpers ───────────────────────────────────────────

async function saveProgram(settings: object): Promise<void> {
  await ctx
    .http()
    .put(`/v1/organizations/${orgId}/loyalty/program`)
    .set(owner.auth)
    .send(settings)
    .expect(200);
}

async function changeProgram(changes: object): Promise<void> {
  const current = await ctx
    .http()
    .get(`/v1/organizations/${orgId}/loyalty/program`)
    .set(owner.auth)
    .expect(200);
  await saveProgram({ ...POINTS, ...changes, version: current.body.version });
}

interface Visit {
  id: string;
  version: number;
  customerId: string;
}

/** A booked visit in two days (one hour each, so they never overlap). */
async function booked(
  opts: { serviceId?: string; staffId?: string; email?: string } = {},
): Promise<Visit> {
  const day = addDays(localToday(Date.now(), TZ), 2);
  const start = new Date(zonedToInstant(day, hour++ * 60, TZ));
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: opts.serviceId ?? haircutId,
      staffId: opts.staffId ?? kasiaStaffId,
      start: start.toISOString(),
      allowOutsideHours: true,
      customer: {
        name: 'Jan Nowak',
        phone: '+48600000002',
        email: opts.email ?? 'jan@example.com',
      },
    })
    .expect(201);
  return { id: res.body.id, version: res.body.version, customerId: res.body.customer.id };
}

/** A visit that already happened, marked "came". */
async function came(opts: Parameters<typeof booked>[0] = {}): Promise<Visit> {
  const visit = await booked(opts);
  const past = new Date(Date.now() - (30 - hour) * 60 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id: visit.id },
    data: {
      startAt: past,
      endAt: new Date(past.getTime() + 30 * 60_000),
      blockedUntil: new Date(past.getTime() + 30 * 60_000),
    },
  });
  const res = await ctx
    .http()
    .post(`${base}/appointments/${visit.id}/status`)
    .set(owner.auth)
    .send({ version: visit.version, status: 'completed' })
    .expect(200);
  return { ...visit, version: res.body.version };
}

const orgUrl = () => `/v1/organizations/${orgId}/loyalty`;

/** A coupon for the client: points added by hand, then exchanged for a new reward. */
async function coupon(
  customerId: string,
  terms: { kind?: string; discountPercent?: number; freeServiceId?: string; serviceIds?: string[] },
): Promise<{ id: string; code: string }> {
  const reward = await ctx
    .http()
    .post(`${orgUrl()}/rewards`)
    .set(owner.auth)
    .send({
      name: `Nagroda ${hour}-${Math.random()}`,
      kind: 'discount_percent',
      cost: 10,
      ...terms,
    })
    .expect(201);
  await ctx
    .http()
    .post(`${orgUrl()}/accounts/${customerId}/adjustments`)
    .set(owner.auth)
    .send({ points: 10, reason: 'For the test' })
    .expect(201);
  const res = await ctx
    .http()
    .post(`${orgUrl()}/accounts/${customerId}/redemptions`)
    .set(owner.auth)
    .send({ rewardId: reward.body.id })
    .expect(201);
  return { id: res.body.id, code: res.body.code };
}

const apply = (visit: { id: string }, body: object, auth = owner.auth) =>
  ctx.http().post(`${base}/appointments/${visit.id}/coupons`).set(auth).send(body);

const remove = (visit: { id: string }, couponId: string, version: number, auth = owner.auth) =>
  ctx
    .http()
    .post(`${base}/appointments/${visit.id}/coupons/${couponId}/remove`)
    .set(auth)
    .send({ version });

const list = (visit: { id: string }, auth = owner.auth) =>
  ctx.http().get(`${base}/appointments/${visit.id}/coupons`).set(auth);

const couponRow = (id: string) => ctx.prisma.loyaltyCoupon.findUniqueOrThrow({ where: { id } });

// ── Tests ─────────────────────────────────────────────

describe('what a coupon takes off', () => {
  const rules = { maxDiscountPercent: 50, allowStacking: true };
  const visit = { serviceId: 's1', priceGrosze: 8000 };
  const percent = (id: string, discountPercent: number, serviceIds: string[] = []) => ({
    id,
    kind: 'discount_percent' as const,
    discountPercent,
    freeServiceId: null,
    serviceIds,
    status: 'active' as const,
    expiresAt: null,
  });

  it('follows the salon’s rules', () => {
    expect(couponDiscount(rules, visit, percent('a', 25), [])).toEqual({
      discountGrosze: 2000,
      problem: null,
    });
    // The maximum share cuts percentage discounts, alone and together.
    expect(couponDiscount(rules, visit, percent('a', 80), []).discountGrosze).toBe(4000);
    const first = { id: 'a', kind: 'discount_percent' as const, discountGrosze: 2400 };
    expect(couponDiscount(rules, visit, percent('b', 30), [first]).discountGrosze).toBe(1600);
    expect(
      couponDiscount(rules, visit, percent('c', 10), [
        first,
        { id: 'b', kind: 'discount_percent', discountGrosze: 1600 },
      ]).problem,
    ).toBe('NO_DISCOUNT');
    expect(
      couponDiscount({ ...rules, allowStacking: false }, visit, percent('b', 30), [first]).problem,
    ).toBe('NOT_COMBINABLE');
    expect(couponDiscount(rules, visit, percent('a', 25, ['s2']), []).problem).toBe(
      'NOT_FOR_SERVICE',
    );
    expect(
      couponDiscount(rules, visit, { ...percent('a', 25), expiresAt: new Date(1000) }, []).problem,
    ).toBe('EXPIRED');
    // A free service is the whole price, whatever the maximum share.
    const free = { ...percent('f', 0), kind: 'free_service' as const, discountPercent: null };
    expect(couponDiscount(rules, visit, { ...free, freeServiceId: 's1' }, []).discountGrosze).toBe(
      8000,
    );
    expect(couponDiscount(rules, visit, { ...free, freeServiceId: 's2' }, []).problem).toBe(
      'NOT_FOR_SERVICE',
    );
    // Rounded down to whole hundredths.
    expect(
      couponDiscount(rules, { serviceId: 's1', priceGrosze: 999 }, percent('a', 15), [])
        .discountGrosze,
    ).toBe(149);
  });

  it('codes are found however the client reads them out', () => {
    expect(normaliseCode('k7qm 4xtb')).toBe('K7QM-4XTB');
    expect(normaliseCode('K7QM4XTB')).toBe('K7QM-4XTB');
    expect(normaliseCode('K7QM-4XTB')).toBe('K7QM-4XTB');
  });
});

describe('coupons on a visit', () => {
  it('the salon uses a coupon by its code; the price goes down; cancelling gives it back', async () => {
    const visit = await booked();
    const quarter = await coupon(visit.customerId, {
      discountPercent: 25,
      serviceIds: [haircutId],
    });
    const freeBeard = await coupon(visit.customerId, {
      kind: 'free_service',
      freeServiceId: beardId,
    });

    const before = await list(visit).expect(200);
    expectShape('VisitCoupons', before.body);
    expect(before.body.applied).toEqual([]);
    expect(before.body.available).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: quarter.id, discountGrosze: 2000, problem: null }),
        expect.objectContaining({
          id: freeBeard.id,
          discountGrosze: null,
          problem: 'NOT_FOR_SERVICE',
        }),
      ]),
    );

    const used = await apply(visit, {
      version: visit.version,
      code: quarter.code.toLowerCase().replace('-', ' '),
    }).expect(200);
    expectShape('AppointmentDetail', used.body);
    expect(used.body).toMatchObject({
      priceGrosze: 8000,
      discountGrosze: 2000,
      version: visit.version + 1,
      coupons: [{ id: quarter.id, code: quarter.code, discountGrosze: 2000, discountPercent: 25 }],
    });
    expect(used.body.history.at(-1)).toMatchObject({
      type: 'coupon_applied',
      data: { couponId: quarter.id, discountGrosze: 2000 },
    });
    expect(await couponRow(quarter.id)).toMatchObject({
      status: 'used',
      usedAppointmentId: visit.id,
      discountGrosze: 2000,
    });

    // The calendar shows the discount too.
    const day = addDays(localToday(Date.now(), TZ), 2);
    const calendar = await ctx
      .http()
      .get(`${base}/appointments`)
      .query({ from: day, to: day })
      .set(owner.auth)
      .expect(200);
    expect(calendar.body.find((a: { id: string }) => a.id === visit.id)).toMatchObject({
      discountGrosze: 2000,
      coupons: [{ id: quarter.id }],
    });

    // Used coupons are not offered again; the salon does not combine discounts.
    const after = await list(visit).expect(200);
    expect(after.body.applied).toEqual([expect.objectContaining({ id: quarter.id })]);
    expect(after.body.available.map((c: { id: string }) => c.id)).toEqual([freeBeard.id]);
    const another = await coupon(visit.customerId, { discountPercent: 10 });
    expectError(
      (await apply(visit, { version: used.body.version, couponId: another.id }).expect(409)).body,
      'COUPON_NOT_COMBINABLE',
    );
    expectError(
      (await apply(visit, { version: used.body.version, couponId: quarter.id }).expect(409)).body,
      'COUPON_NOT_ACTIVE',
    );
    expectError(
      (await apply(visit, { version: used.body.version, couponId: freeBeard.id }).expect(409)).body,
      'COUPON_NOT_FOR_SERVICE',
    );
    // An old version: someone else changed the visit.
    expectError(
      (await apply(visit, { version: visit.version, couponId: another.id }).expect(409)).body,
      'VERSION_CONFLICT',
    );

    const cancelled = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/cancel`)
      .set(owner.auth)
      .send({ version: used.body.version, reason: 'Klient zachorował' })
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', discountGrosze: 0, coupons: [] });
    expect(cancelled.body.history.at(-1)).toMatchObject({
      type: 'cancelled',
      data: { couponsReturned: 1 },
    });
    expect(await couponRow(quarter.id)).toMatchObject({
      status: 'active',
      usedAppointmentId: null,
      usedAt: null,
      discountGrosze: null,
    });
  });

  it('loyalty is earned on what the client paid; a paid visit keeps its coupons', async () => {
    const visit = await came();
    const quarter = await coupon(visit.customerId, { discountPercent: 25 });
    const used = await apply(visit, { version: visit.version, couponId: quarter.id }).expect(200);

    const paid = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/payment`)
      .set(owner.auth)
      .send({ version: used.body.version, paid: true })
      .expect(200);
    // 60 zł paid → 6 points (10 per 100 zł).
    expect(paid.body.history.at(-1)).toMatchObject({ type: 'paid', data: { loyaltyEarned: 6 } });

    expectError(
      (await remove(visit, quarter.id, paid.body.version).expect(409)).body,
      'VISIT_NOT_CHANGEABLE',
    );
    const other = await coupon(visit.customerId, { discountPercent: 10 });
    expectError(
      (await apply(visit, { version: paid.body.version, couponId: other.id }).expect(409)).body,
      'VISIT_NOT_CHANGEABLE',
    );

    // Refund first, then the coupon can come off and be used again.
    const refunded = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/payment`)
      .set(owner.auth)
      .send({ version: paid.body.version, paid: false })
      .expect(200);
    const removed = await remove(visit, quarter.id, refunded.body.version).expect(200);
    expect(removed.body).toMatchObject({ discountGrosze: 0, coupons: [] });
    expect(removed.body.history.at(-1)).toMatchObject({
      type: 'coupon_removed',
      data: { couponId: quarter.id },
    });
    expect((await couponRow(quarter.id)).status).toBe('active');
    await remove(visit, quarter.id, removed.body.version).expect(404);
  });

  it('combined discounts stop at the salon’s maximum; a free service is the whole price', async () => {
    await changeProgram({ allowStacking: true });
    const visit = await booked();
    const a = await coupon(visit.customerId, { discountPercent: 30 });
    const b = await coupon(visit.customerId, { discountPercent: 30 });
    const c = await coupon(visit.customerId, { discountPercent: 10 });
    const first = await apply(visit, { version: visit.version, couponId: a.id }).expect(200);
    const second = await apply(visit, { version: first.body.version, couponId: b.id }).expect(200);
    expect(second.body).toMatchObject({
      discountGrosze: 4000,
      coupons: [
        { id: a.id, discountGrosze: 2400 },
        { id: b.id, discountGrosze: 1600 },
      ],
    });
    const offered = await list(visit).expect(200);
    expect(offered.body.available).toEqual([
      expect.objectContaining({ id: c.id, problem: 'NO_DISCOUNT', discountGrosze: null }),
    ]);
    expectError(
      (await apply(visit, { version: second.body.version, couponId: c.id }).expect(409)).body,
      'COUPON_NO_DISCOUNT',
    );

    const beard = await booked({ serviceId: beardId });
    const free = await coupon(beard.customerId, { kind: 'free_service', freeServiceId: beardId });
    const freeVisit = await apply(beard, { version: beard.version, couponId: free.id }).expect(200);
    expect(freeVisit.body).toMatchObject({ priceGrosze: 4000, discountGrosze: 4000 });
  });

  it('"did not come" gives the coupon back', async () => {
    const visit = await came();
    const quarter = await coupon(visit.customerId, { discountPercent: 25 });
    const used = await apply(visit, { version: visit.version, couponId: quarter.id }).expect(200);
    const noShow = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/status`)
      .set(owner.auth)
      .send({ version: used.body.version, status: 'no_show' })
      .expect(200);
    expect(noShow.body).toMatchObject({ discountGrosze: 0, coupons: [] });
    expect((await couponRow(quarter.id)).status).toBe('active');
  });

  it('an expired coupon cannot be used', async () => {
    const visit = await booked();
    const quarter = await coupon(visit.customerId, { discountPercent: 25 });
    await ctx.prisma.loyaltyCoupon.update({
      where: { id: quarter.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await list(visit).expect(200)).body.available[0]).toMatchObject({
      problem: 'EXPIRED',
    });
    expectError(
      (await apply(visit, { version: visit.version, couponId: quarter.id }).expect(409)).body,
      'COUPON_EXPIRED',
    );
  });

  it('one coupon on two visits at the same moment is used once', async () => {
    const one = await booked();
    const two = await booked();
    const quarter = await coupon(one.customerId, { discountPercent: 25 });
    const both = await Promise.all([
      apply(one, { version: one.version, couponId: quarter.id }),
      apply(two, { version: two.version, couponId: quarter.id }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const discounts = await ctx.prisma.appointment.findMany({
      where: { id: { in: [one.id, two.id] } },
      select: { discountGrosze: true },
    });
    expect(discounts.map((d) => d.discountGrosze).sort((x, y) => x - y)).toEqual([0, 2000]);
  });
});

describe('who may use coupons', () => {
  it('another client’s or another salon’s coupon is "not found"', async () => {
    const jan = await booked();
    const ewa = await booked({ email: 'ewa@example.com' });
    const ewasCoupon = await coupon(ewa.customerId, { discountPercent: 25 });
    await apply(jan, { version: jan.version, couponId: ewasCoupon.id }).expect(404);
    await apply(jan, { version: jan.version, code: ewasCoupon.code }).expect(404);
    expect((await list(jan).expect(200)).body.available).toEqual([]);

    const stranger = await signUp(ctx, 'stranger@example.com');
    await list(jan, stranger.auth).expect(404);
    await apply(jan, { version: jan.version, couponId: ewasCoupon.id }, stranger.auth).expect(404);
  });

  it('a staff member uses coupons on own visits only', async () => {
    const own = await booked({ staffId: kasiaStaffId });
    const olas = await booked({ staffId: olaStaffId });
    const quarter = await coupon(own.customerId, { discountPercent: 25 });
    await list(own, kasia.auth).expect(200);
    await apply(olas, { version: olas.version, couponId: quarter.id }, kasia.auth).expect(404);
    const used = await apply(
      own,
      { version: own.version, couponId: quarter.id },
      kasia.auth,
    ).expect(200);
    expect(used.body.coupons).toHaveLength(1);
  });

  it('the request needs exactly one of couponId and code', async () => {
    const visit = await booked();
    await apply(visit, { version: visit.version }).expect(400);
    await apply(visit, {
      version: visit.version,
      couponId: '00000000-0000-7000-8000-000000000000',
      code: 'AAAA-BBBB',
    }).expect(400);
  });
});
