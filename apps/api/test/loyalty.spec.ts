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
