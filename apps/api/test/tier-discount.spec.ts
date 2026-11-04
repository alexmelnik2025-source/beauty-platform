import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
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

/** Task 10e, part 3: the client's tier discount used on a visit, by the same rules as coupons. */

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

const putTiers = (tiers: object[], basis = 'visits') =>
  ctx
    .http()
    .put(`${orgUrl()}/tiers`)
    .set(owner.auth)
    .send({ basis, periodDays: 365, tiers })
    .expect(200);

/** Everyone is Silver (−10%) from the first visit; Gold (−20%) after 5 paid visits. */
const SILVER_GOLD = [
  { name: 'Silver', threshold: 0, discountPercent: 10 },
  { name: 'Gold', threshold: 5, discountPercent: 20 },
];

const useTier = (visit: { id: string }, version: number, auth = owner.auth) =>
  ctx.http().post(`${base}/appointments/${visit.id}/tier-discount`).set(auth).send({ version });

const removeTier = (visit: { id: string }, version: number, auth = owner.auth) =>
  ctx
    .http()
    .post(`${base}/appointments/${visit.id}/tier-discount/remove`)
    .set(auth)
    .send({ version });

// ── Tests ─────────────────────────────────────────────

describe('tier discount on a visit', () => {
  it('the salon uses the client’s tier discount; the price goes down; it can come off again', async () => {
    await putTiers(SILVER_GOLD);
    const visit = await booked();

    const offer = await list(visit).expect(200);
    expectShape('VisitCoupons', offer.body);
    expect(offer.body.tier).toEqual({
      name: 'Silver',
      discountPercent: 10,
      discountGrosze: 800,
      applied: false,
      problem: null,
    });

    const used = await useTier(visit, visit.version).expect(200);
    expectShape('AppointmentDetail', used.body);
    expect(used.body).toMatchObject({
      priceGrosze: 8000,
      discountGrosze: 800,
      coupons: [],
      tierDiscount: { name: 'Silver', discountPercent: 10, discountGrosze: 800 },
      version: visit.version + 1,
    });
    expect(used.body.history.at(-1)).toMatchObject({
      type: 'tier_discount_applied',
      data: { name: 'Silver', discountPercent: 10, discountGrosze: 800 },
    });
    const after = await list(visit).expect(200);
    expect(after.body.tier).toMatchObject({ name: 'Silver', applied: true, discountGrosze: 800 });

    // Once per visit; an old version means someone else changed the visit.
    expectError((await useTier(visit, used.body.version).expect(409)).body, 'COUPON_NOT_ACTIVE');
    expectError((await removeTier(visit, visit.version).expect(409)).body, 'VERSION_CONFLICT');

    // The salon renames the tier later: the visit keeps what it was.
    await putTiers([{ name: 'Srebrny', threshold: 0, discountPercent: 15 }]);
    const again = await list(visit).expect(200);
    expect(again.body.tier).toMatchObject({ name: 'Silver', discountPercent: 10 });

    const removed = await removeTier(visit, used.body.version).expect(200);
    expect(removed.body).toMatchObject({ discountGrosze: 0, tierDiscount: null });
    expect(removed.body.history.at(-1)).toMatchObject({
      type: 'tier_discount_removed',
      data: { name: 'Silver' },
    });
    expectError((await removeTier(visit, removed.body.version).expect(404)).body, 'NOT_FOUND');
    // Now the current tier is offered.
    const now = await list(visit).expect(200);
    expect(now.body.tier).toMatchObject({ name: 'Srebrny', discountGrosze: 1200, applied: false });
  });

  it('one discount per visit unless the salon combines them; together they stop at the maximum', async () => {
    await putTiers(SILVER_GOLD);
    const visit = await booked();
    const quarter = await coupon(visit.customerId, { discountPercent: 25 });
    const withCoupon = await apply(visit, { version: visit.version, couponId: quarter.id }).expect(
      200,
    );
    const offer = await list(visit).expect(200);
    expect(offer.body.tier).toMatchObject({ discountGrosze: null, problem: 'NOT_COMBINABLE' });
    expectError(
      (await useTier(visit, withCoupon.body.version).expect(409)).body,
      'COUPON_NOT_COMBINABLE',
    );

    // The other way round: with the tier discount, a coupon is not combined either.
    const second = await booked();
    const tiered = await useTier(second, second.version).expect(200);
    const other = await coupon(second.customerId, { discountPercent: 10 });
    expectError(
      (await apply(second, { version: tiered.body.version, couponId: other.id }).expect(409)).body,
      'COUPON_NOT_COMBINABLE',
    );

    // Combined: 10% tier + 45% coupon stop at the salon's 50% (8000 → 4000 off in all).
    await changeProgram({ allowStacking: true });
    const big = await coupon(second.customerId, { discountPercent: 45 });
    const both = await apply(second, { version: tiered.body.version, couponId: big.id }).expect(
      200,
    );
    expect(both.body).toMatchObject({
      discountGrosze: 4000,
      tierDiscount: { discountGrosze: 800 },
      coupons: [{ id: big.id, discountGrosze: 3200 }],
    });
    // Taking the coupon off leaves the tier discount.
    const left = await remove(second, big.id, both.body.version).expect(200);
    expect(left.body).toMatchObject({ discountGrosze: 800, coupons: [] });

    // Cancelling drops the tier discount and gives the coupon back.
    const third = await booked();
    const t = await useTier(third, third.version).expect(200);
    const c = await coupon(third.customerId, { discountPercent: 20 });
    const u = await apply(third, { version: t.body.version, couponId: c.id }).expect(200);
    const cancelled = await ctx
      .http()
      .post(`${base}/appointments/${third.id}/cancel`)
      .set(owner.auth)
      .send({ version: u.body.version, reason: 'Klient zachorował' })
      .expect(200);
    expect(cancelled.body).toMatchObject({ discountGrosze: 0, coupons: [], tierDiscount: null });
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: third.id } });
    expect(row).toMatchObject({ tierDiscountGrosze: 0, tierName: null, tierDiscountPercent: null });
  });

  it('loyalty is earned on what the client paid; a paid visit keeps its tier discount', async () => {
    await putTiers([{ name: 'VIP', threshold: 0, discountPercent: 50 }]);
    const visit = await came();
    const used = await useTier(visit, visit.version).expect(200);
    const paid = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/payment`)
      .set(owner.auth)
      .send({ version: used.body.version, paid: true })
      .expect(200);
    // 40 zł paid → 4 points (10 per 100 zł).
    expect(paid.body.history.at(-1)).toMatchObject({ type: 'paid', data: { loyaltyEarned: 4 } });
    expectError(
      (await removeTier(visit, paid.body.version).expect(409)).body,
      'VISIT_NOT_CHANGEABLE',
    );
  });

  it('no tier with a discount, or the program is off: nothing to use', async () => {
    const visit = await booked();
    expect((await list(visit).expect(200)).body.tier).toBeNull();
    expectError((await useTier(visit, visit.version).expect(409)).body, 'TIER_NO_DISCOUNT');

    await putTiers([{ name: 'Standard', threshold: 0, discountPercent: 0 }]);
    expect((await list(visit).expect(200)).body.tier).toBeNull();

    await putTiers(SILVER_GOLD);
    await changeProgram({ enabled: false });
    expect((await list(visit).expect(200)).body.tier).toBeNull();
    expectError((await useTier(visit, visit.version).expect(409)).body, 'TIER_NO_DISCOUNT');
  });

  it('a staff member uses it on own visits only', async () => {
    await putTiers(SILVER_GOLD);
    const own = await booked();
    const olas = await booked({ staffId: olaStaffId });
    await useTier(own, own.version, kasia.auth).expect(200);
    // Someone else's visit is not even visible to her.
    await useTier(olas, olas.version, kasia.auth).expect(404);
  });
});
