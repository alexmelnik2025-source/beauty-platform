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
 * Owner test T6: a client came without a booking — the salon enters the visit afterwards
 * (today or yesterday) straight away as "came", optionally "paid" so loyalty is earned.
 */

const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;

let ctx: TestContext;
let owner: SignedInUser;
let kasia: SignedInUser;
let orgId: string;
let base: string;
let haircutId: string;
let kasiaStaffId: string;
let olaStaffId: string;

/** `hoursAgo` hours before now, on a 5-minute mark. */
const ago = (hoursAgo: number): string =>
  new Date(Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN - hoursAgo * HOUR).toISOString();

function walkIn(
  start: string,
  extra: Record<string, unknown> = {},
  auth = owner.auth,
  staffId = kasiaStaffId,
) {
  return ctx
    .http()
    .post(`${base}/appointments`)
    .set(auth)
    .send({
      serviceId: haircutId,
      staffId,
      start,
      customer: { name: 'Jan Nowak', phone: '+48600000002', email: 'jan@example.com' },
      alreadyHappened: true,
      ...extra,
    });
}

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
  haircutId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  const ids: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [haircutId] })
      .expect(201);
    ids.push(staff.body.id);
  }
  [kasiaStaffId, olaStaffId] = ids as [string, string];
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
  await ctx
    .http()
    .put(`/v1/organizations/${orgId}/loyalty/program`)
    .set(owner.auth)
    .send({
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
      version: 0,
    })
    .expect(200);
});

describe('a visit entered afterwards (walk-in)', () => {
  it('is saved as "came" without emails; a normal booking in the past is still refused', async () => {
    const before = await ctx.prisma.notificationOutbox.count();
    const res = await walkIn(ago(2)).expect(201);
    const parsed = registeredResponseSchema('AppointmentDetail').safeParse(res.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(res.body).toMatchObject({ status: 'completed', source: 'manual', paidAt: null });
    expect(res.body.history.map((h: { type: string }) => h.type)).toEqual(['created', 'completed']);
    // The client was there: no confirmation or reminder email.
    expect(await ctx.prisma.notificationOutbox.count()).toBe(before);

    // "Paid" can be marked right away.
    const paid = await ctx
      .http()
      .post(`${base}/appointments/${res.body.id}/payment`)
      .set(owner.auth)
      .send({ version: res.body.version, paid: true })
      .expect(200);
    expect(paid.body.paidAt).not.toBeNull();

    const plain = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: olaStaffId,
        start: ago(1),
        customer: { name: 'Ewa', phone: '+48600000003' },
      })
      .expect(400);
    expectError(plain.body, 'IN_THE_PAST');
  });

  it('can be paid at once: loyalty points are earned', async () => {
    const res = await walkIn(ago(3), { paid: true }).expect(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.paidAt).not.toBeNull();
    expect(res.body.history.map((h: { type: string }) => h.type)).toEqual([
      'created',
      'completed',
      'paid',
    ]);
    const acc = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/loyalty/accounts/${res.body.customer.id}`)
      .set(owner.auth)
      .expect(200);
    expect(acc.body).toMatchObject({ balance: 8, lifetimeEarned: 8 });
  });

  it('only today or yesterday, never in the future; paid needs alreadyHappened', async () => {
    expectError((await walkIn(ago(72)).expect(400)).body, 'TOO_LONG_AGO');
    expectError((await walkIn(ago(-2)).expect(400)).body, 'NOT_STARTED');
    const paidOnly = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: kasiaStaffId,
        start: ago(-24),
        customer: { name: 'Ewa', phone: '+48600000003' },
        paid: true,
      })
      .expect(400);
    expectError(paidOnly.body, 'VALIDATION_ERROR');
  });

  it('does not overlap other visits of the same specialist', async () => {
    const start = ago(4);
    await walkIn(start).expect(201);
    expectError((await walkIn(start).expect(409)).body, 'SLOT_TAKEN');
    // Another specialist at the same time is fine.
    await walkIn(start, {}, owner.auth, olaStaffId).expect(201);

    // An unmarked booking at that time (still "confirmed") also blocks it.
    const booked = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: kasiaStaffId,
        start: ago(-30),
        allowOutsideHours: true,
        customer: { name: 'Ewa', phone: '+48600000003' },
      })
      .expect(201);
    const past = new Date(ago(6));
    await ctx.prisma.appointment.update({
      where: { id: booked.body.id },
      data: {
        startAt: past,
        endAt: new Date(past.getTime() + 30 * 60_000),
        blockedUntil: new Date(past.getTime() + 30 * 60_000),
      },
    });
    expectError((await walkIn(ago(6)).expect(409)).body, 'SLOT_TAKEN');
  });

  it('a master enters own walk-ins only', async () => {
    await walkIn(ago(2), { paid: true }, kasia.auth).expect(201);
    await walkIn(ago(2), {}, kasia.auth, olaStaffId).expect(403);
  });
});
