import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { earnAmount } from '../src/loyalty/loyalty-ledger';
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

/** Loyalty core (task 10a, part 1): settings, earning for paid visits, taking back, safety. */

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
let hour = 9;

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

const STAMPS = { ...POINTS, mode: 'stamps', pointsValidityDays: null } as const;

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
});

// ── Helpers ───────────────────────────────────────────

const program = (auth = owner.auth) =>
  ctx.http().get(`/v1/organizations/${orgId}/loyalty/program`).set(auth);

async function saveProgram(settings: object, auth = owner.auth, expected = 200) {
  const current = await program(owner.auth).expect(200);
  return ctx
    .http()
    .put(`/v1/organizations/${orgId}/loyalty/program`)
    .set(auth)
    .send({ ...settings, version: current.body.version })
    .expect(expected);
}

/** A visit that already happened (an hour slot in the past), status "came". */
async function completedVisit(
  opts: { serviceId?: string; staffId?: string; email?: string } = {},
): Promise<{ id: string; version: number; customerId: string }> {
  const day = addDays(localToday(Date.now(), TZ), 2);
  const start = new Date(zonedToInstant(day, hour++ * 60, TZ));
  const booked = await ctx
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
  // Only a visit that has started can be marked as "came": move it into the past directly.
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
    .post(`${base}/appointments/${booked.body.id}/status`)
    .set(owner.auth)
    .send({ version: booked.body.version, status: 'completed' })
    .expect(200);
  return { id: came.body.id, version: came.body.version, customerId: came.body.customer.id };
}

const pay = (visit: { id: string }, version: number, paid = true, auth = owner.auth) =>
  ctx.http().post(`${base}/appointments/${visit.id}/payment`).set(auth).send({ version, paid });

const account = (customerId: string) =>
  ctx
    .http()
    .get(`/v1/organizations/${orgId}/loyalty/accounts/${customerId}`)
    .set(owner.auth)
    .expect(200);

// ── Tests ─────────────────────────────────────────────

describe('earning rules', () => {
  it('follow the salon’s numbers', () => {
    const points = { ...POINTS, minSpendGrosze: 5000 };
    expect(earnAmount(points, undefined, 8000)).toBe(8);
    expect(earnAmount(points, undefined, 12_999)).toBe(12);
    expect(earnAmount(points, undefined, 4999)).toBe(0);
    expect(earnAmount(points, 5, 8000)).toBe(5);
    expect(earnAmount(points, 0, 8000)).toBe(0);
    expect(earnAmount(STAMPS, undefined, 100)).toBe(1);
    expect(earnAmount({ ...STAMPS, stampsPerVisit: 2 }, undefined, 100)).toBe(2);
  });
});

describe('program settings', () => {
  it('starts switched off; the owner saves it, with versions', async () => {
    const empty = await program().expect(200);
    expectShape('LoyaltyProgram', empty.body);
    expect(empty.body).toMatchObject({ enabled: false, mode: 'stamps', version: 0 });

    const saved = await saveProgram(POINTS);
    expectShape('LoyaltyProgram', saved.body);
    expect(saved.body).toMatchObject({ ...POINTS, version: 1, earnRules: [] });

    // A stale version is refused.
    const stale = await ctx
      .http()
      .put(`/v1/organizations/${orgId}/loyalty/program`)
      .set(owner.auth)
      .send({ ...POINTS, version: 0 })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');

    const audit = await ctx.prisma.auditLog.findMany({
      where: { organizationId: orgId, action: 'loyalty.program.updated' },
    });
    expect(audit).toHaveLength(1);
  });

  it('per-service rules belong to one location and only to its services', async () => {
    const res = await ctx
      .http()
      .put(`${base}/loyalty/earn-rules`)
      .set(owner.auth)
      .send({
        rules: [
          { serviceId: haircutId, points: 15 },
          { serviceId: beardId, points: 0 },
        ],
      })
      .expect(200);
    expectShape('LoyaltyProgram', res.body);
    expect(res.body.earnRules).toEqual(
      expect.arrayContaining([
        { serviceId: haircutId, serviceName: 'Strzyżenie', locationId, points: 15 },
        { serviceId: beardId, serviceName: 'Broda', locationId, points: 0 },
      ]),
    );
    // Replacing keeps only the new list.
    const replaced = await ctx
      .http()
      .put(`${base}/loyalty/earn-rules`)
      .set(owner.auth)
      .send({ rules: [{ serviceId: beardId, points: 3 }] })
      .expect(200);
    expect(replaced.body.earnRules).toEqual([
      { serviceId: beardId, serviceName: 'Broda', locationId, points: 3 },
    ]);

    const other = await createOrgWithLocation(ctx, owner, 'Second');
    const foreign = await ctx
      .http()
      .post(`/v1/organizations/${other.orgId}/locations/${other.locationId}/services`)
      .set(owner.auth)
      .send({ name: 'Obcy', durationMinutes: 30, priceGrosze: 1000 })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/loyalty/earn-rules`)
      .set(owner.auth)
      .send({ rules: [{ serviceId: foreign.body.id, points: 100 }] })
      .expect(404);
    await ctx
      .http()
      .put(`${base}/loyalty/earn-rules`)
      .set(owner.auth)
      .send({
        rules: [
          { serviceId: beardId, points: 1 },
          { serviceId: beardId, points: 2 },
        ],
      })
      .expect(400);
  });

  it('staff members cannot see or change the program, nor give points', async () => {
    await program(kasia.auth).expect(403);
    await saveProgram(POINTS, kasia.auth, 403);
    await ctx
      .http()
      .put(`${base}/loyalty/earn-rules`)
      .set(kasia.auth)
      .send({ rules: [{ serviceId: haircutId, points: 1000 }] })
      .expect(403);
    await ctx
      .http()
      .get(`/v1/organizations/${orgId}/loyalty/transactions`)
      .set(kasia.auth)
      .expect(403);
    expect(await ctx.prisma.loyaltyProgram.count()).toBe(0);
  });
});

describe('earning for paid visits', () => {
  it('a paid, completed visit earns once; refund takes it back', async () => {
    await saveProgram(POINTS);
    const visit = await completedVisit();

    const paid = await pay(visit, visit.version).expect(200);
    expectShape('AppointmentDetail', paid.body);
    expect(paid.body.paidAt).not.toBeNull();
    expect(paid.body.history.at(-1)).toMatchObject({ type: 'paid', data: { loyaltyEarned: 8 } });

    // A double click or a retry with the old version earns nothing more.
    await pay(visit, visit.version).expect(409);
    await pay(visit, paid.body.version).expect(200);

    const acc = await account(visit.customerId);
    expectShape('LoyaltyAccount', acc.body);
    expect(acc.body).toMatchObject({ mode: 'points', balance: 8, lifetimeEarned: 8 });
    expect(acc.body.transactions).toHaveLength(1);
    const [earn] = acc.body.transactions;
    expect(earn).toMatchObject({ type: 'earn', points: 8, balanceAfter: 8 });
    expect(earn.appointmentId).toBe(visit.id);
    expect(earn.actorUserId).toBe(owner.userId);
    // Points expire after the salon's validity (365 days).
    const days = (Date.parse(earn.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);

    // Refund: not paid any more → taken back, history keeps both entries.
    const refunded = await pay(visit, paid.body.version, false).expect(200);
    expect(refunded.body.paidAt).toBeNull();
    const after = await account(visit.customerId);
    expect(after.body).toMatchObject({ balance: 0, lifetimeEarned: 0 });
    expect(after.body.transactions[0]).toMatchObject({
      type: 'reverse',
      points: -8,
      balanceAfter: 0,
      reversesId: earn.id,
      note: null,
    });

    // Paid again (the refund was a mistake): earns again, under a new key.
    await pay(visit, refunded.body.version).expect(200);
    expect((await account(visit.customerId)).body.balance).toBe(8);
    expect(await ctx.prisma.loyaltyTransaction.count({ where: { type: 'earn' } })).toBe(2);
  });

  it('only completed visits; "did not come" afterwards takes the points back', async () => {
    await saveProgram(STAMPS);
    const day = addDays(localToday(Date.now(), TZ), 2);
    const future = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: kasiaStaffId,
        start: new Date(zonedToInstant(day, 20 * 60, TZ)).toISOString(),
        allowOutsideHours: true,
        customer: { name: 'Ewa', phone: '+48600000003' },
      })
      .expect(201);
    expectError((await pay(future.body, future.body.version).expect(409)).body, 'NOT_COMPLETED');

    const visit = await completedVisit();
    const paid = await pay(visit, visit.version).expect(200);
    expect((await account(visit.customerId)).body.balance).toBe(1);
    const noShow = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/status`)
      .set(owner.auth)
      .send({ version: paid.body.version, status: 'no_show' })
      .expect(200);
    expect(noShow.body.paidAt).toBeNull();
    expect(noShow.body.history.at(-1)).toMatchObject({
      type: 'no_show',
      data: { loyaltyTakenBack: 1 },
    });
    expect((await account(visit.customerId)).body.balance).toBe(0);
  });

  it('nothing is earned while the program is off, below the minimum or for a 0-rule', async () => {
    const off = await completedVisit();
    await pay(off, off.version).expect(200);

    await saveProgram({ ...POINTS, minSpendGrosze: 5000 });
    await ctx
      .http()
      .put(`${base}/loyalty/earn-rules`)
      .set(owner.auth)
      .send({ rules: [{ serviceId: haircutId, points: 0 }] })
      .expect(200);
    const cheap = await completedVisit({ serviceId: beardId });
    await pay(cheap, cheap.version).expect(200);
    const excluded = await completedVisit({ serviceId: haircutId });
    await pay(excluded, excluded.version).expect(200);

    expect(await ctx.prisma.loyaltyTransaction.count()).toBe(0);
    // Refunding a visit that earned nothing is fine too.
    const latest = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: cheap.id } });
    await pay(cheap, latest.version, false).expect(200);
  });

  it('a service rule replaces the general rule', async () => {
    await saveProgram(POINTS);
    await ctx
      .http()
      .put(`${base}/loyalty/earn-rules`)
      .set(owner.auth)
      .send({ rules: [{ serviceId: beardId, points: 5 }] })
      .expect(200);
    const visit = await completedVisit({ serviceId: beardId });
    await pay(visit, visit.version).expect(200);
    expect((await account(visit.customerId)).body.balance).toBe(5);
  });

  it('a staff member marks only own visits as paid, by the salon’s rules', async () => {
    await saveProgram(POINTS);
    const own = await completedVisit({ staffId: kasiaStaffId });
    const other = await completedVisit({ staffId: olaStaffId });
    await pay(own, own.version, true, kasia.auth).expect(200);
    await pay(other, other.version, true, kasia.auth).expect(404);
    expect((await account(own.customerId)).body.balance).toBe(8);
  });

  it('refund after the points were spent: the balance never goes below zero', async () => {
    await saveProgram(POINTS);
    const visit = await completedVisit();
    const paid = await pay(visit, visit.version).expect(200);
    // Spending comes in part 2; here the balance is lowered directly to simulate it.
    await ctx.prisma.loyaltyAccount.updateMany({ data: { balance: 3 } });
    await pay(visit, paid.body.version, false).expect(200);
    const acc = await account(visit.customerId);
    expect(acc.body.balance).toBe(0);
    expect(acc.body.transactions[0]).toMatchObject({ type: 'reverse', points: -3 });
    expect(acc.body.transactions[0].note).toContain('5 of 8');
  });

  it('many visits paid at the same moment: one account, every visit counted once', async () => {
    await saveProgram(STAMPS);
    const visits = [];
    for (let i = 0; i < 5; i++) visits.push(await completedVisit());
    const results = await Promise.all(visits.map((v) => pay(v, v.version)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // The same refund twice at once: one wins, the other gets a version conflict.
    const again = await Promise.all([pay(visits[0]!, 3, false), pay(visits[0]!, 3, false)]);
    expect(again.map((r) => r.status).sort()).toEqual([200, 409]);

    expect(await ctx.prisma.loyaltyAccount.count()).toBe(1);
    const acc = await account(visits[0]!.customerId);
    expect(acc.body.balance).toBe(4);
    expect(acc.body.lifetimeEarned).toBe(4);
    expect(
      acc.body.transactions.filter((t: { type: string }) => t.type === 'reverse'),
    ).toHaveLength(1);
  });

  it('the program type cannot change while clients have a balance', async () => {
    await saveProgram(STAMPS);
    const visit = await completedVisit();
    await pay(visit, visit.version).expect(200);
    expectError((await saveProgram(POINTS, owner.auth, 409)).body, 'LOYALTY_MODE_LOCKED');
    // Other settings can still change.
    await saveProgram({ ...STAMPS, stampsPerVisit: 2 });
  });
});

describe('history and protection in the database', () => {
  it('the owner sees every operation; ledger rows cannot be edited', async () => {
    await saveProgram(POINTS);
    const jan = await completedVisit();
    const paidJan = await pay(jan, jan.version).expect(200);
    const ewa = await completedVisit({ email: 'ewa@example.com' });
    await pay(ewa, ewa.version).expect(200);
    await pay(jan, paidJan.body.version, false).expect(200);

    const all = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/loyalty/transactions`)
      .set(owner.auth)
      .expect(200);
    expectShape('LoyaltyTransactionList', all.body);
    expect(all.body.map((t: { type: string }) => t.type)).toEqual(['reverse', 'earn', 'earn']);
    const onlyEwa = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/loyalty/transactions`)
      .query({ customerId: ewa.customerId })
      .set(owner.auth)
      .expect(200);
    expect(onlyEwa.body).toHaveLength(1);

    await expect(
      ctx.prisma.loyaltyTransaction.updateMany({ data: { points: 1000 } }),
    ).rejects.toThrow();
    await expect(ctx.prisma.loyaltyAccount.updateMany({ data: { balance: -1 } })).rejects.toThrow();
  });

  it('another salon’s client is "not found"', async () => {
    const stranger = await signUp(ctx, 'stranger@example.com');
    const theirs = await createOrgWithLocation(ctx, stranger, 'Other');
    const customer = await ctx.prisma.customer.create({
      data: { organizationId: theirs.orgId, name: 'Obcy', phone: '+48600000009' },
    });
    await ctx
      .http()
      .get(`/v1/organizations/${orgId}/loyalty/accounts/${customer.id}`)
      .set(owner.auth)
      .expect(404);
    const list = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/loyalty/transactions`)
      .query({ customerId: customer.id })
      .set(owner.auth)
      .expect(200);
    expect(list.body).toEqual([]);
  });
});

// ── Rewards, coupons, manual corrections (task 10a, part 2) ─────────────

const orgUrl = () => `/v1/organizations/${orgId}/loyalty`;

const reward = (body: object, auth = owner.auth) =>
  ctx.http().post(`${orgUrl()}/rewards`).set(auth).send(body);

const redeem = (customerId: string, rewardId: string, auth = owner.auth) =>
  ctx.http().post(`${orgUrl()}/accounts/${customerId}/redemptions`).set(auth).send({ rewardId });

const adjust = (customerId: string, points: number, reason = 'Visit before the program') =>
  ctx
    .http()
    .post(`${orgUrl()}/accounts/${customerId}/adjustments`)
    .set(owner.auth)
    .send({ points, reason });

/** A client with a card in the salon (from one visit, not paid: no balance yet). */
async function client(email = 'jan@example.com'): Promise<string> {
  return (await completedVisit({ email })).customerId;
}

describe('reward catalogue', () => {
  it('the owner adds, changes and removes rewards; kinds are checked', async () => {
    const ten = await reward({
      name: 'Rabat 10%',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 20,
    }).expect(201);
    expectShape('LoyaltyReward', ten.body);
    expect(ten.body).toMatchObject({
      kind: 'discount_percent',
      discountPercent: 10,
      freeServiceId: null,
      cost: 20,
      serviceIds: [],
      couponValidityDays: null,
      archivedAt: null,
      version: 1,
    });
    const free = await reward({
      name: 'Darmowe strzyżenie',
      kind: 'free_service',
      freeServiceId: haircutId,
      cost: 100,
      couponValidityDays: 30,
    }).expect(201);

    // A discount without a percent, a free service without a service, both at once → 400.
    await reward({ name: 'X', kind: 'discount_percent', cost: 5 }).expect(400);
    await reward({ name: 'X', kind: 'free_service', cost: 5 }).expect(400);
    await reward({
      name: 'X',
      kind: 'discount_percent',
      discountPercent: 5,
      freeServiceId: haircutId,
      cost: 5,
    }).expect(400);
    await reward({ name: 'X', kind: 'discount_percent', discountPercent: 101, cost: 5 }).expect(
      400,
    );
    await reward({ name: 'X', kind: 'discount_percent', discountPercent: 5, cost: 0 }).expect(400);

    const changed = await ctx
      .http()
      .put(`${orgUrl()}/rewards/${ten.body.id}`)
      .set(owner.auth)
      .send({
        version: 1,
        name: 'Rabat 15% na brodę',
        kind: 'discount_percent',
        discountPercent: 15,
        cost: 25,
        serviceIds: [beardId],
      })
      .expect(200);
    expect(changed.body).toMatchObject({ discountPercent: 15, serviceIds: [beardId], version: 2 });
    const stale = await ctx
      .http()
      .put(`${orgUrl()}/rewards/${ten.body.id}`)
      .set(owner.auth)
      .send({ version: 1, name: 'Old', kind: 'discount_percent', discountPercent: 5, cost: 5 })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');

    const list = await ctx.http().get(`${orgUrl()}/rewards`).set(owner.auth).expect(200);
    expectShape('LoyaltyRewardList', list.body);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([ten.body.id, free.body.id]);

    await ctx.http().delete(`${orgUrl()}/rewards/${free.body.id}`).set(owner.auth).expect(204);
    await ctx.http().delete(`${orgUrl()}/rewards/${free.body.id}`).set(owner.auth).expect(204);
    const active = await ctx.http().get(`${orgUrl()}/rewards`).set(owner.auth).expect(200);
    expect(active.body).toHaveLength(1);
    const all = await ctx
      .http()
      .get(`${orgUrl()}/rewards`)
      .query({ includeArchived: 'true' })
      .set(owner.auth)
      .expect(200);
    expect(all.body).toHaveLength(2);

    const actions = await ctx.prisma.auditLog.findMany({
      where: { organizationId: orgId, action: { startsWith: 'loyalty.reward.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'loyalty.reward.created',
      'loyalty.reward.created',
      'loyalty.reward.updated',
      'loyalty.reward.archived',
    ]);
  });

  it('only the salon’s own services; the database refuses a broken reward', async () => {
    const other = await createOrgWithLocation(ctx, owner, 'Second');
    const foreign = await ctx
      .http()
      .post(`/v1/organizations/${other.orgId}/locations/${other.locationId}/services`)
      .set(owner.auth)
      .send({ name: 'Obcy', durationMinutes: 30, priceGrosze: 1000 })
      .expect(201);
    await reward({
      name: 'X',
      kind: 'free_service',
      freeServiceId: foreign.body.id,
      cost: 5,
    }).expect(404);
    await reward({
      name: 'X',
      kind: 'discount_percent',
      discountPercent: 10,
      serviceIds: [haircutId, foreign.body.id],
      cost: 5,
    }).expect(404);

    const program = await ctx.prisma.loyaltyProgram.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId },
      update: {},
    });
    await expect(
      ctx.prisma.loyaltyReward.create({
        data: { programId: program.id, name: 'Broken', kind: 'free_service', cost: 5 },
      }),
    ).rejects.toThrow();
  });

  it('staff members cannot see or change rewards, nor give them', async () => {
    const r = await reward({
      name: 'R',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 1,
    }).expect(201);
    const customerId = await client();
    await ctx.http().get(`${orgUrl()}/rewards`).set(kasia.auth).expect(403);
    await reward(
      { name: 'R', kind: 'discount_percent', discountPercent: 10, cost: 1 },
      kasia.auth,
    ).expect(403);
    await ctx.http().delete(`${orgUrl()}/rewards/${r.body.id}`).set(kasia.auth).expect(403);
    await redeem(customerId, r.body.id, kasia.auth).expect(403);
    await ctx
      .http()
      .post(`${orgUrl()}/accounts/${customerId}/adjustments`)
      .set(kasia.auth)
      .send({ points: 100, reason: 'Gift' })
      .expect(403);
    expect(await ctx.prisma.loyaltyTransaction.count()).toBe(0);
  });
});

describe('exchanging for rewards', () => {
  it('points: the cost is taken, the client gets a coupon with a code and a copy of the terms', async () => {
    await saveProgram(POINTS);
    const customerId = await client();
    await adjust(customerId, 50).expect(201);
    const r = await reward({
      name: 'Rabat 25%',
      kind: 'discount_percent',
      discountPercent: 25,
      cost: 40,
      serviceIds: [haircutId],
      couponValidityDays: 30,
    }).expect(201);

    const coupon = await redeem(customerId, r.body.id).expect(201);
    expectShape('LoyaltyCoupon', coupon.body);
    expect(coupon.body).toMatchObject({
      rewardId: r.body.id,
      name: 'Rabat 25%',
      kind: 'discount_percent',
      discountPercent: 25,
      serviceIds: [haircutId],
      cost: 40,
      status: 'active',
      usedAt: null,
      cancelledAt: null,
    });
    expect(coupon.body.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    const days = (Date.parse(coupon.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    // 10 points left: not enough for a second one.
    expectError((await redeem(customerId, r.body.id).expect(409)).body, 'LOYALTY_NOT_ENOUGH');

    // Changing the reward later does not change the coupon.
    await ctx
      .http()
      .put(`${orgUrl()}/rewards/${r.body.id}`)
      .set(owner.auth)
      .send({ version: 1, name: 'Rabat 5%', kind: 'discount_percent', discountPercent: 5, cost: 1 })
      .expect(200);

    const acc = await account(customerId);
    expectShape('LoyaltyAccount', acc.body);
    expect(acc.body).toMatchObject({ balance: 10, lifetimeEarned: 0 });
    expect(acc.body.coupons).toHaveLength(1);
    expect(acc.body.coupons[0]).toMatchObject({ name: 'Rabat 25%', discountPercent: 25 });
    expect(acc.body.transactions[0]).toMatchObject({
      type: 'redeem',
      points: -40,
      balanceAfter: 10,
      note: 'Rabat 25%',
    });
  });

  it('stamps: taking a reward starts the card again', async () => {
    await saveProgram(STAMPS);
    const customerId = await client();
    for (let i = 0; i < 5; i++) {
      const visit = await completedVisit();
      await pay(visit, visit.version).expect(200);
    }
    const r25 = await reward({
      name: '−25%',
      kind: 'discount_percent',
      discountPercent: 25,
      cost: 3,
    }).expect(201);
    const free = await reward({
      name: 'Gratis',
      kind: 'free_service',
      freeServiceId: haircutId,
      cost: 6,
    }).expect(201);
    expectError((await redeem(customerId, free.body.id).expect(409)).body, 'LOYALTY_NOT_ENOUGH');

    const coupon = await redeem(customerId, r25.body.id).expect(201);
    expect(coupon.body).toMatchObject({ cost: 5, status: 'active', expiresAt: null });
    const acc = await account(customerId);
    expect(acc.body.balance).toBe(0);
    expect(acc.body.lifetimeEarned).toBe(5);
    expect(acc.body.transactions[0]).toMatchObject({ type: 'redeem', points: -5 });
    expect(acc.body.transactions[0].note).toContain('starts again');
  });

  it('a removed reward, a switched-off program or another salon’s reward cannot be taken', async () => {
    await saveProgram(POINTS);
    const customerId = await client();
    await adjust(customerId, 100).expect(201);
    const r = await reward({
      name: 'R',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 10,
    }).expect(201);

    await saveProgram({ ...POINTS, enabled: false });
    expectError((await redeem(customerId, r.body.id).expect(409)).body, 'LOYALTY_DISABLED');
    await saveProgram(POINTS);

    await ctx.http().delete(`${orgUrl()}/rewards/${r.body.id}`).set(owner.auth).expect(204);
    await redeem(customerId, r.body.id).expect(404);

    const stranger = await signUp(ctx, 'stranger@example.com');
    const theirs = await createOrgWithLocation(ctx, stranger, 'Other');
    const foreign = await ctx
      .http()
      .post(`/v1/organizations/${theirs.orgId}/loyalty/rewards`)
      .set(stranger.auth)
      .send({ name: 'Theirs', kind: 'discount_percent', discountPercent: 50, cost: 1 })
      .expect(201);
    await redeem(customerId, foreign.body.id).expect(404);
    expect((await account(customerId)).body.balance).toBe(100);
  });

  it('two exchanges at the same moment never spend the same points twice', async () => {
    await saveProgram(POINTS);
    const customerId = await client();
    await adjust(customerId, 50).expect(201);
    const r = await reward({
      name: 'R',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 30,
    }).expect(201);
    const results = await Promise.all([1, 2, 3, 4].map(() => redeem(customerId, r.body.id)));
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409, 409]);
    const acc = await account(customerId);
    expect(acc.body.balance).toBe(20);
    expect(acc.body.coupons).toHaveLength(1);
  });

  it('cancelling an unused coupon gives the points back, once', async () => {
    await saveProgram(POINTS);
    const customerId = await client();
    await adjust(customerId, 40).expect(201);
    const r = await reward({
      name: 'R',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 40,
    }).expect(201);
    const coupon = await redeem(customerId, r.body.id).expect(201);
    const cancelUrl = `${orgUrl()}/coupons/${coupon.body.id}/cancel`;

    const both = await Promise.all([
      ctx.http().post(cancelUrl).set(owner.auth).send({ version: 1 }),
      ctx.http().post(cancelUrl).set(owner.auth).send({ version: 1 }),
    ]);
    expect(both.map((res) => res.status).sort()).toEqual([200, 409]);
    const cancelled = both.find((res) => res.status === 200)!;
    expectShape('LoyaltyCoupon', cancelled.body);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', version: 2 });
    expect(cancelled.body.cancelledAt).not.toBeNull();
    expectError(
      (await ctx.http().post(cancelUrl).set(owner.auth).send({ version: 2 }).expect(409)).body,
      'COUPON_NOT_ACTIVE',
    );
    await ctx.http().post(cancelUrl).set(kasia.auth).send({ version: 2 }).expect(403);

    const acc = await account(customerId);
    expect(acc.body.balance).toBe(40);
    const redeemEntry = acc.body.transactions.find((t: { type: string }) => t.type === 'redeem');
    expect(acc.body.transactions[0]).toMatchObject({
      type: 'reverse',
      points: 40,
      balanceAfter: 40,
      reversesId: redeemEntry.id,
    });
  });

  it('a coupon past its date shows as expired', async () => {
    await saveProgram(POINTS);
    const customerId = await client();
    await adjust(customerId, 10).expect(201);
    const r = await reward({
      name: 'R',
      kind: 'discount_percent',
      discountPercent: 10,
      cost: 10,
      couponValidityDays: 1,
    }).expect(201);
    const coupon = await redeem(customerId, r.body.id).expect(201);
    await ctx.prisma.loyaltyCoupon.update({
      where: { id: coupon.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await account(customerId)).body.coupons[0].status).toBe('expired');
  });
});

describe('manual corrections', () => {
  it('with a reason, never below zero, visible in the history', async () => {
    await saveProgram(POINTS);
    const customerId = await client();
    const added = await adjust(customerId, 30, 'Wizyty sprzed programu').expect(201);
    expectShape('LoyaltyAccount', added.body);
    expect(added.body).toMatchObject({ balance: 30, lifetimeEarned: 0 });
    expect(added.body.transactions[0]).toMatchObject({
      type: 'adjust',
      points: 30,
      balanceAfter: 30,
      note: 'Wizyty sprzed programu',
      actorUserId: owner.userId,
    });
    // Added points get the program's validity, like earned ones.
    expect(added.body.transactions[0].expiresAt).not.toBeNull();

    expectError((await adjust(customerId, -31).expect(409)).body, 'LOYALTY_NOT_ENOUGH');
    const taken = await adjust(customerId, -30, 'Pomyłka').expect(201);
    expect(taken.body.balance).toBe(0);
    expect(taken.body.transactions[0].expiresAt).toBeNull();

    await adjust(customerId, 0).expect(400);
    await ctx
      .http()
      .post(`${orgUrl()}/accounts/${customerId}/adjustments`)
      .set(owner.auth)
      .send({ points: 5, reason: '' })
      .expect(400);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { organizationId: orgId, action: 'loyalty.balance.adjusted' },
    });
    expect(audit).toHaveLength(2);
  });
});
