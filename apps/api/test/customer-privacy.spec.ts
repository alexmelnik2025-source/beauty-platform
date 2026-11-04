import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Task 21 (MVP spec, "client rights"): the salon owner exports everything kept about a
 * client and erases the personal data on request. Erasure keeps the visits for statistics.
 */

const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let ctx: TestContext;
let owner: SignedInUser;
let manager: SignedInUser;
let kasia: SignedInUser;
let orgId: string;
let base: string;
let customersBase: string;
let haircutId: string;
let staffId: string;
let customerId: string;

/** On a 5-minute mark, `ms` from now. */
const fromNow = (ms: number): string =>
  new Date(Math.floor((Date.now() + ms) / FIVE_MIN) * FIVE_MIN).toISOString();

function expectShape(name: string, body: unknown): void {
  const result = registeredResponseSchema(name).safeParse(body);
  expect(result.error?.issues ?? [], `response does not match ${name}`).toEqual([]);
}

async function member(user: SignedInUser, role: 'manager' | 'staff', locationId: string) {
  return ctx.prisma.membership.create({
    data: {
      userId: user.userId,
      organizationId: orgId,
      role,
      locations: { create: [{ locationId }] },
    },
  });
}

/** A visit two hours ago, entered afterwards as "came" and paid (earns points). */
async function pastPaidVisit(): Promise<string> {
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId,
      start: fromNow(-2 * HOUR),
      customerId,
      note: 'Lubi krótko po bokach',
      alreadyHappened: true,
      paid: true,
    })
    .expect(201);
  return res.body.id;
}

/** A visit in three days. */
async function futureVisit(): Promise<{ id: string; version: number }> {
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId,
      start: fromNow(3 * DAY),
      customerId,
      allowOutsideHours: true,
    })
    .expect(201);
  return { id: res.body.id, version: res.body.version };
}

const card = (auth = owner.auth) => ctx.http().get(`${customersBase}/${customerId}`).set(auth);

const anonymize = (version: number, auth = owner.auth) =>
  ctx.http().post(`${customersBase}/${customerId}/anonymize`).set(auth).send({ version });

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  let locationId: string;
  ({ orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  customersBase = `/v1/organizations/${orgId}/customers`;
  haircutId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  staffId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [haircutId] })
      .expect(201)
  ).body.id;
  manager = await signUp(ctx, 'manager@example.com');
  await member(manager, 'manager', locationId);
  kasia = await signUp(ctx, 'kasia@example.com');
  await member(kasia, 'staff', locationId);
  await ctx.prisma.staffMember.update({ where: { id: staffId }, data: { userId: kasia.userId } });
  await ctx
    .http()
    .put(`/v1/organizations/${orgId}/loyalty/program`)
    .set(owner.auth)
    .send({
      enabled: true,
      mode: 'points',
      stampsPerVisit: 1,
      pointsPerUnit: 10,
      spendUnitGrosze: 1000,
      minSpendGrosze: 0,
      pointsValidityDays: 365,
      maxDiscountPercent: 50,
      allowStacking: false,
      marketplaceEnabled: false,
      version: 0,
    })
    .expect(200);
  customerId = (
    await ctx
      .http()
      .post(customersBase)
      .set(owner.auth)
      .send({
        name: 'Jan Nowak',
        phone: '+48600000002',
        email: 'jan@example.com',
        note: 'Alergia na lateks',
        tags: ['stały'],
      })
      .expect(201)
  ).body.id;
});

describe('client data export (GDPR access request)', () => {
  it('the owner downloads everything kept about the client as a JSON file', async () => {
    await pastPaidVisit();
    const res = await ctx.http().get(`${customersBase}/${customerId}/export`).set(owner.auth);
    expect(res.status).toBe(200);
    expectShape('CustomerExport', res.body);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="client-${customerId}.json"`,
    );
    expect(res.body).toMatchObject({
      salon: { name: 'Barber' },
      client: {
        name: 'Jan Nowak',
        phone: '+48600000002',
        email: 'jan@example.com',
        note: 'Alergia na lateks',
        tags: ['stały'],
      },
    });
    expect(res.body.visits).toHaveLength(1);
    expect(res.body.visits[0]).toMatchObject({
      service: 'Strzyżenie',
      specialist: 'Kasia',
      status: 'completed',
      priceGrosze: 8000,
      currency: 'PLN',
      paid: true,
      note: 'Lubi krótko po bokach',
    });
    expect(res.body.loyalty[0].balance).toBeGreaterThan(0);
    expect(res.body.loyalty[0].history[0]).toMatchObject({ type: 'earn' });
    const log = await ctx.prisma.auditLog.findFirst({ where: { action: 'customer.exported' } });
    expect(log).toMatchObject({ entityId: customerId, actorUserId: owner.userId });
  });

  it('only the owner: managers and staff get 403', async () => {
    for (const user of [manager, kasia]) {
      const res = await ctx.http().get(`${customersBase}/${customerId}/export`).set(user.auth);
      expect(res.status).toBe(403);
    }
  });
});

describe('client data erasure (GDPR)', () => {
  it('waits until upcoming visits are cancelled', async () => {
    const visit = await futureVisit();
    const refused = await anonymize(1).expect(409);
    expectError(refused.body, 'CUSTOMER_HAS_UPCOMING_VISITS');
    await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/cancel`)
      .set(owner.auth)
      .send({ version: visit.version, reason: 'Jan prosi o usunięcie danych' })
      .expect(200);
    const before = (await card().expect(200)).body;
    await anonymize(before.version).expect(200);
  });

  it('erases the personal data and keeps the visits for statistics', async () => {
    const pastId = await pastPaidVisit();
    const future = await futureVisit();
    await ctx
      .http()
      .post(`${base}/appointments/${future.id}/cancel`)
      .set(owner.auth)
      .send({ version: future.version, reason: 'Jan Nowak dzwonił: wyjazd' })
      .expect(200);
    await ctx.prisma.appointmentAccessToken.create({
      data: {
        appointmentId: pastId,
        tokenHash: 'h'.repeat(64),
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    const before = (await card().expect(200)).body;
    expect(before.anonymizedAt).toBeNull();
    const staffNotifications = () =>
      ctx.prisma.notification.findMany({
        where: { appointmentId: { in: [pastId, future.id] } },
      });
    expect(JSON.stringify(await staffNotifications())).toContain('Jan Nowak');

    const res = await anonymize(before.version).expect(200);
    expectShape('AnonymizedCustomer', res.body);
    expect(res.body).toMatchObject({ id: customerId, visitsKept: 2 });

    const after = (await card().expect(200)).body;
    expectShape('CustomerDetail', after);
    expect(after).toMatchObject({
      name: '—',
      phone: '',
      email: null,
      note: null,
      tags: [],
      anonymizedAt: res.body.anonymizedAt,
    });
    expect(after.visits).toHaveLength(2);

    // Visits and prices stay, without the free text.
    const visits = await ctx.prisma.appointment.findMany({ where: { customerId } });
    expect(visits.map((v) => [v.priceGrosze, v.note, v.cancelReason, v.holdContact])).toEqual([
      [8000, null, null, null],
      [8000, null, null, null],
    ]);
    const events = await ctx.prisma.appointmentEvent.findMany({
      where: { appointmentId: future.id },
    });
    expect(JSON.stringify(events)).not.toContain('wyjazd');
    expect(events.some((e) => e.type === 'cancelled')).toBe(true);
    expect(JSON.stringify(await staffNotifications())).not.toContain('Jan Nowak');
    expect(
      await ctx.prisma.appointmentAccessToken.count({ where: { appointmentId: pastId } }),
    ).toBe(0);
    // Loyalty entries stay (the ledger is append-only).
    expect(await ctx.prisma.loyaltyTransaction.count()).toBeGreaterThan(0);

    // Not listed any more, cannot be filled in again or erased twice.
    const list = await ctx.http().get(customersBase).set(owner.auth).expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).not.toContain(customerId);
    const patch = await ctx
      .http()
      .patch(`${customersBase}/${customerId}`)
      .set(owner.auth)
      .send({ version: after.version, name: 'Jan Nowak' })
      .expect(409);
    expectError(patch.body, 'CUSTOMER_ANONYMIZED');
    expectError((await anonymize(after.version).expect(409)).body, 'CUSTOMER_ANONYMIZED');

    const log = await ctx.prisma.auditLog.findFirst({ where: { action: 'customer.anonymized' } });
    expect(log).toMatchObject({ entityId: customerId, actorUserId: owner.userId });
    expect(JSON.stringify(log)).not.toContain('Jan');
  });

  it('checks the version and the role', async () => {
    expectError((await anonymize(99).expect(409)).body, 'VERSION_CONFLICT');
    for (const user of [manager, kasia]) {
      expect((await anonymize(1, user.auth)).status).toBe(403);
    }
    const unchanged = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(unchanged).toMatchObject({ name: 'Jan Nowak', anonymizedAt: null });
  });
});
