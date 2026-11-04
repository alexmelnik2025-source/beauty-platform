import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  expectError,
  createTestApp,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 10d, part 3: the client picks one of their coupons for an upcoming visit in "My visits". */

const TZ = 'Europe/Warsaw';
const ANNA = 'anna.client@example.com';
const BOB = 'bob.client@example.com';

const PROGRAM = {
  enabled: true,
  mode: 'points',
  stampsPerVisit: 1,
  pointsPerUnit: 10,
  spendUnitGrosze: 10_000,
  minSpendGrosze: 0,
  pointsValidityDays: null,
  maxDiscountPercent: 50,
  allowStacking: false,
  marketplaceEnabled: false,
} as const;

interface Salon {
  owner: SignedInUser;
  orgId: string;
  base: string;
  slug: string;
  haircutId: string;
  beardId: string;
  staffId: string;
}

let ctx: TestContext;
let hour = 9;

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
  hour = 9;
});

// ── Helpers ───────────────────────────────────────────

async function setupSalon(ownerEmail: string, name: string, online = true): Promise<Salon> {
  const owner = await signUp(ctx, ownerEmail);
  const { orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, name);
  const base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = (serviceName: string, priceGrosze: number) =>
    ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: serviceName, durationMinutes: 30, priceGrosze })
      .expect(201);
  const haircutId = (await service('Strzyżenie', 8000)).body.id as string;
  const beardId = (await service('Broda', 4000)).body.id as string;
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [haircutId, beardId] })
    .expect(201);
  if (online) {
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(200);
  }
  return { owner, orgId, base, slug, haircutId, beardId, staffId: staff.body.id };
}

const loyaltyUrl = (salon: Salon) => `/v1/organizations/${salon.orgId}/loyalty`;

async function saveProgram(salon: Salon, settings: object): Promise<void> {
  const current = await ctx
    .http()
    .get(`${loyaltyUrl(salon)}/program`)
    .set(salon.owner.auth);
  await ctx
    .http()
    .put(`${loyaltyUrl(salon)}/program`)
    .set(salon.owner.auth)
    .send({ ...PROGRAM, ...settings, version: current.body.version })
    .expect(200);
}

async function addReward(salon: Salon, body: object): Promise<string> {
  const res = await ctx
    .http()
    .post(`${loyaltyUrl(salon)}/rewards`)
    .set(salon.owner.auth)
    .send(body)
    .expect(201);
  return res.body.id as string;
}

const adjust = (salon: Salon, customerId: string, points: number) =>
  ctx
    .http()
    .post(`${loyaltyUrl(salon)}/accounts/${customerId}/adjustments`)
    .set(salon.owner.auth)
    .send({ points, reason: 'Secret staff note about the client' })
    .expect(201);

const redeem = (salon: Salon, customerId: string, rewardId: string) =>
  ctx
    .http()
    .post(`${loyaltyUrl(salon)}/accounts/${customerId}/redemptions`)
    .set(salon.owner.auth)
    .send({ rewardId })
    .expect(201);

function lastCode(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code sent to ${email}`);
  return match[1];
}

async function signIn(email: string): Promise<{ Authorization: string }> {
  await ctx.http().post('/v1/client/auth/code').send({ email, locale: 'pl' }).expect(202);
  const res = await ctx
    .http()
    .post('/v1/client/auth/verify')
    .send({ email, code: lastCode(email), clientType: 'mobile' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

/** A visit booked by the salon for the client, in two days. */
async function upcoming(salon: Salon, email = ANNA): Promise<{ id: string; customerId: string }> {
  const day = addDays(localToday(Date.now(), TZ), 2);
  const start = new Date(zonedToInstant(day, hour++ * 60, TZ));
  const booked = await ctx
    .http()
    .post(`${salon.base}/appointments`)
    .set(salon.owner.auth)
    .send({
      serviceId: salon.haircutId,
      staffId: salon.staffId,
      start: start.toISOString(),
      allowOutsideHours: true,
      customer: { name: 'Anna Kowalska', phone: '+48600100200', email },
    })
    .expect(201);
  return { id: booked.body.id, customerId: booked.body.customer.id };
}

/** A coupon for the client: points from the salon, exchanged for a reward. */
async function coupon(salon: Salon, customerId: string, reward: object): Promise<string> {
  const rewardId = await addReward(salon, { cost: 10, ...reward });
  await adjust(salon, customerId, 10);
  return (await redeem(salon, customerId, rewardId)).body.id as string;
}

const visitUrl = (id: string) => `/v1/client/appointments/${id}`;

describe('coupons on my upcoming visit', () => {
  it('I pick a coupon, see the new price, take it off again', async () => {
    const salon = await setupSalon('owner@example.com', 'Barber');
    await saveProgram(salon, {});
    const visit = await upcoming(salon);
    const quarter = await coupon(salon, visit.customerId, {
      name: 'Rabat 25%',
      kind: 'discount_percent',
      discountPercent: 25,
    });
    const freeBeard = await coupon(salon, visit.customerId, {
      name: 'Broda gratis',
      kind: 'free_service',
      freeServiceId: salon.beardId,
    });
    const anna = await signIn(ANNA);

    const offer = await ctx
      .http()
      .get(`${visitUrl(visit.id)}/coupons`)
      .set(anna)
      .expect(200);
    expectShape('VisitCoupons', offer.body);
    expect(offer.body.available).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: quarter, discountGrosze: 2000, problem: null }),
        expect.objectContaining({ id: freeBeard, problem: 'NOT_FOR_SERVICE' }),
      ]),
    );

    const used = await ctx
      .http()
      .post(`${visitUrl(visit.id)}/coupons`)
      .set(anna)
      .send({ couponId: quarter })
      .expect(200);
    expectShape('ClientAppointment', used.body);
    expect(used.body).toMatchObject({
      discountGrosze: 2000,
      coupons: [{ id: quarter, name: 'Rabat 25%', discountGrosze: 2000 }],
    });
    const mine = await ctx
      .http()
      .get('/v1/client/appointments')
      .query({ scope: 'upcoming' })
      .set(anna)
      .expect(200);
    expect(mine.body.items[0]).toMatchObject({ discountGrosze: 2000 });

    // The salon sees it in the visit, done by the client.
    const salonView = await ctx
      .http()
      .get(`${salon.base}/appointments/${visit.id}`)
      .set(salon.owner.auth)
      .expect(200);
    expect(salonView.body).toMatchObject({ discountGrosze: 2000 });
    expect(salonView.body.history.at(-1)).toMatchObject({
      type: 'coupon_applied',
      actor: 'customer',
    });

    const removed = await ctx
      .http()
      .post(`${visitUrl(visit.id)}/coupons/${quarter}/remove`)
      .set(anna)
      .expect(200);
    expect(removed.body).toMatchObject({ discountGrosze: 0, coupons: [] });
  });

  it('cancelling my visit gives the coupon back', async () => {
    const salon = await setupSalon('owner@example.com', 'Barber');
    await saveProgram(salon, {});
    const visit = await upcoming(salon);
    const quarter = await coupon(salon, visit.customerId, {
      name: 'Rabat 25%',
      kind: 'discount_percent',
      discountPercent: 25,
    });
    const anna = await signIn(ANNA);
    await ctx
      .http()
      .post(`${visitUrl(visit.id)}/coupons`)
      .set(anna)
      .send({ couponId: quarter })
      .expect(200);
    await ctx
      .http()
      .post(`${visitUrl(visit.id)}/cancel`)
      .set(anna)
      .send({})
      .expect(200);
    const row = await ctx.prisma.loyaltyCoupon.findUniqueOrThrow({ where: { id: quarter } });
    expect(row).toMatchObject({ status: 'active', usedAppointmentId: null });
    const after = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: visit.id } });
    expect(after.discountGrosze).toBe(0);
  });

  it('not after the salon’s deadline, and never someone else’s visit or coupon', async () => {
    const salon = await setupSalon('owner@example.com', 'Barber');
    await saveProgram(salon, {});
    const visit = await upcoming(salon);
    const quarter = await coupon(salon, visit.customerId, {
      name: 'Rabat 25%',
      kind: 'discount_percent',
      discountPercent: 25,
    });
    const bobVisit = await upcoming(salon, BOB);
    const bobsCoupon = await coupon(salon, bobVisit.customerId, {
      name: 'Rabat 10%',
      kind: 'discount_percent',
      discountPercent: 10,
    });
    const anna = await signIn(ANNA);
    const bob = await signIn(BOB);

    // Bob cannot see or change Anna's visit; Anna cannot use Bob's coupon.
    await ctx
      .http()
      .get(`${visitUrl(visit.id)}/coupons`)
      .set(bob)
      .expect(404);
    await ctx
      .http()
      .post(`${visitUrl(visit.id)}/coupons`)
      .set(bob)
      .send({ couponId: bobsCoupon })
      .expect(404);
    await ctx
      .http()
      .post(`${visitUrl(visit.id)}/coupons`)
      .set(anna)
      .send({ couponId: bobsCoupon })
      .expect(404);

    // An hour before the visit (the deadline is 2 hours): too late online.
    const soon = new Date(Date.now() + 60 * 60_000);
    await ctx.prisma.appointment.update({
      where: { id: visit.id },
      data: {
        startAt: soon,
        endAt: new Date(soon.getTime() + 30 * 60_000),
        blockedUntil: new Date(soon.getTime() + 30 * 60_000),
      },
    });
    expectError(
      (
        await ctx
          .http()
          .post(`${visitUrl(visit.id)}/coupons`)
          .set(anna)
          .send({ couponId: quarter })
          .expect(409)
      ).body,
      'TOO_LATE_TO_CHANGE',
    );
  });
});
