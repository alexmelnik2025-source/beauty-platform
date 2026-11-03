import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientLoyaltyResponse } from '../src/client/client-loyalty.responses';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** "My bonuses" in the client app (task 10c): progress, rewards, coupons, history. */

const TZ = 'Europe/Warsaw';
const ANNA = 'anna.client@example.com';
const BOB = 'bob.client@example.com';

const PROGRAM = {
  enabled: true,
  mode: 'stamps',
  stampsPerVisit: 1,
  pointsPerUnit: 10,
  spendUnitGrosze: 10_000,
  minSpendGrosze: 0,
  pointsValidityDays: null,
  maxDiscountPercent: 100,
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
      .send({ version: loc.body.version, onlineBookingEnabled: true })
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

/** A visit in the past, marked "came" and "paid"; returns the client card id. */
async function paidVisit(salon: Salon, email = ANNA, serviceId = salon.haircutId): Promise<string> {
  const day = addDays(localToday(Date.now(), TZ), 2);
  const start = new Date(zonedToInstant(day, hour++ * 60, TZ));
  const booked = await ctx
    .http()
    .post(`${salon.base}/appointments`)
    .set(salon.owner.auth)
    .send({
      serviceId,
      staffId: salon.staffId,
      start: start.toISOString(),
      allowOutsideHours: true,
      customer: { name: 'Anna Kowalska', phone: '+48600100200', email },
    })
    .expect(201);
  const past = new Date(Date.now() - (30 - hour) * 60 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id: booked.body.id },
    data: {
      startAt: past,
      endAt: new Date(past.getTime() + 30 * 60_000),
      blockedUntil: new Date(past.getTime() + 30 * 60_000),
    },
  });
  const came = await ctx
    .http()
    .post(`${salon.base}/appointments/${booked.body.id}/status`)
    .set(salon.owner.auth)
    .send({ version: booked.body.version, status: 'completed' })
    .expect(200);
  await ctx
    .http()
    .post(`${salon.base}/appointments/${booked.body.id}/payment`)
    .set(salon.owner.auth)
    .send({ version: came.body.version, paid: true })
    .expect(200);
  return came.body.customer.id as string;
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

async function myBonuses(email = ANNA) {
  const auth = await signIn(email);
  const res = await ctx.http().get('/v1/client/loyalty').set(auth).expect(200);
  expectShape('ClientLoyalty', res.body);
  return (res.body as ClientLoyaltyResponse).items;
}

// ── Tests ─────────────────────────────────────────────

describe('my bonuses', () => {
  it('needs the client to sign in; nothing yet for a new client', async () => {
    await ctx.http().get('/v1/client/loyalty').expect(401);
    expect(await myBonuses()).toEqual([]);
  });

  it('stamp card: how many visits are left, rewards, history without staff notes', async () => {
    const salon = await setupSalon('owner@example.com', 'Gestalt Barber');
    await saveProgram(salon, {});
    const small = await addReward(salon, {
      name: '−25%',
      kind: 'discount_percent',
      discountPercent: 25,
      cost: 3,
    });
    const free = await addReward(salon, {
      name: 'Darmowe strzyżenie',
      kind: 'free_service',
      freeServiceId: salon.haircutId,
      serviceIds: [salon.haircutId],
      cost: 6,
      couponValidityDays: 30,
    });
    const archived = await addReward(salon, {
      name: 'Old one',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 1,
    });
    await ctx
      .http()
      .delete(`${loyaltyUrl(salon)}/rewards/${archived}`)
      .set(salon.owner.auth);

    const customerId = await paidVisit(salon);
    let [card] = await myBonuses();
    expect(card).toMatchObject({
      organization: { id: salon.orgId, name: 'Gestalt Barber' },
      bookingSlug: salon.slug,
      enabled: true,
      mode: 'stamps',
      balance: 1,
      lifetimeEarned: 1,
      next: { rewardId: small, missing: 2, visits: 2 },
      coupons: [],
    });
    expect(card!.rewards).toEqual([
      expect.objectContaining({ id: small, missing: 2, serviceNames: [], freeServiceName: null }),
      expect.objectContaining({
        id: free,
        missing: 5,
        freeServiceName: 'Strzyżenie',
        serviceNames: ['Strzyżenie'],
        couponValidityDays: 30,
      }),
    ]);
    expect(card!.history).toEqual([
      expect.objectContaining({
        type: 'earn',
        points: 1,
        balanceAfter: 1,
        serviceName: 'Strzyżenie',
      }),
    ]);

    // The salon adds stamps by hand: the client sees the change, never the staff's reason.
    await adjust(salon, customerId, 2);
    [card] = await myBonuses();
    expect(card).toMatchObject({ balance: 3, next: { rewardId: free, missing: 3, visits: 3 } });
    expect(card!.rewards[0]).toMatchObject({ id: small, missing: 0 });
    expect(card!.history[0]).toMatchObject({ type: 'adjust', points: 2, serviceName: null });
    expect(JSON.stringify(card)).not.toContain('Secret staff note');
  });

  it('coupons: active first with the code; cancelled ones are not shown; expired ones are marked', async () => {
    const salon = await setupSalon('owner@example.com', 'Gestalt Barber');
    await saveProgram(salon, { mode: 'points', pointsValidityDays: 365 });
    const reward = await addReward(salon, {
      name: '−50%',
      kind: 'discount_percent',
      discountPercent: 50,
      cost: 20,
      couponValidityDays: 10,
    });
    const customerId = await paidVisit(salon); // 80 zł → 8 points
    await adjust(salon, customerId, 52);

    const first = await redeem(salon, customerId, reward);
    const second = await redeem(salon, customerId, reward);
    const third = await redeem(salon, customerId, reward);
    await ctx
      .http()
      .post(`${loyaltyUrl(salon)}/coupons/${third.body.id}/cancel`)
      .set(salon.owner.auth)
      .send({ version: third.body.version })
      .expect(200);
    await ctx.prisma.loyaltyCoupon.update({
      where: { id: first.body.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const [card] = await myBonuses();
    expect(card).toMatchObject({
      mode: 'points',
      balance: 20, // 60 − 3 × 20 + 20 given back
      earning: { pointsPerUnit: 10, spendUnitGrosze: 10_000, pointsValidityDays: 365 },
      next: null,
    });
    expect(card!.history[0]).toMatchObject({ type: 'reverse', points: 20 });
    expect(card!.history.find((h) => h.type === 'earn')).toMatchObject({
      points: 8,
      expiresAt: expect.any(String),
    });
    expect(card!.coupons.map((c) => [c.code, c.status])).toEqual([
      [second.body.code, 'active'],
      [first.body.code, 'expired'],
    ]);
  });

  it('only the client’s own cards; a switched-off program shows only while a coupon is usable', async () => {
    const a = await setupSalon('a@example.com', 'Alfa Barber');
    const b = await setupSalon('b@example.com', 'Beta Studio', false);
    const c = await setupSalon('c@example.com', 'Cena Salon');
    for (const salon of [a, b, c]) await saveProgram(salon, {});
    const rewardB = await addReward(b, {
      name: '−10%',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 1,
    });

    await paidVisit(a); // Anna: a card in A without rewards
    const annaInB = await paidVisit(b);
    await paidVisit(c, BOB); // Bob only
    await ctx.prisma.customer.create({
      data: { organizationId: c.orgId, name: 'Not Anna', phone: '+48600999999' },
    });

    let items = await myBonuses();
    expect(items.map((i) => i.organization.name)).toEqual([
      'Alfa Barber Centrum',
      'Beta Studio Centrum',
    ]);
    expect(items[1]).toMatchObject({ bookingSlug: null, next: null });
    expect((await myBonuses(BOB)).map((i) => i.organization.name)).toEqual(['Cena Salon Centrum']);

    // B switches the program off: Anna's coupon there is still shown, A without anything is not.
    await redeem(b, annaInB, rewardB);
    await saveProgram(b, { enabled: false });
    await saveProgram(a, { enabled: false });
    items = await myBonuses();
    expect(items.map((i) => [i.organization.name, i.enabled])).toEqual([
      ['Beta Studio Centrum', false],
    ]);
    expect(items[0]!.coupons).toHaveLength(1);
  });

  it('shows the salon by its place name, never the company’s legal name (owner test T9)', async () => {
    const salon = await setupSalon('legal@example.com', 'GESTALDT Test Sp. z o.o.');
    await saveProgram(salon, {});
    await paidVisit(salon);
    const [card] = await myBonuses();
    expect(card!.organization.name).toBe('GESTALDT Test Sp. z o.o. Centrum');
    await ctx.prisma.location.updateMany({
      where: { organizationId: salon.orgId },
      data: { name: 'GESTALT Barbershop' },
    });
    const [renamed] = await myBonuses();
    expect(renamed!.organization.name).toBe('GESTALT Barbershop');
    expect(JSON.stringify(renamed)).not.toContain('Sp. z o.o.');
  });
});
