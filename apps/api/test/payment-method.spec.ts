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
 * Task 227: how the client paid (cash, card, BLIK, transfer, other) — only a mark the staff
 * sets with "paid"; no payment systems. Shown on the visit, in the report and in the CSV.
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

const pay = (id: string, body: Record<string, unknown>, auth = owner.auth) =>
  ctx.http().post(`${base}/appointments/${id}/payment`).set(auth).send(body);

const detail = async (id: string, auth = owner.auth) =>
  (await ctx.http().get(`${base}/appointments/${id}`).set(auth).expect(200)).body;

describe('payment method (task 227)', () => {
  it('is saved with "paid", can be changed without earning loyalty again, and goes with a refund', async () => {
    const visit = (await walkIn(ago(2)).expect(201)).body;
    expect(visit.paymentMethod).toBeNull();

    const paid = await pay(visit.id, { version: visit.version, paid: true, method: 'card' }).expect(
      200,
    );
    const parsed = registeredResponseSchema('AppointmentDetail').safeParse(paid.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(paid.body).toMatchObject({ paymentMethod: 'card' });
    expect(paid.body.paidAt).not.toBeNull();
    const earned = await ctx.prisma.loyaltyTransaction.count();
    expect(earned).toBe(1);

    // Another method on a paid visit: only the method changes (the client paid once).
    const changed = await pay(visit.id, {
      version: paid.body.version,
      paid: true,
      method: 'cash',
    }).expect(200);
    expect(changed.body).toMatchObject({ paymentMethod: 'cash', paidAt: paid.body.paidAt });
    expect(changed.body.version).toBe(paid.body.version + 1);
    expect(await ctx.prisma.loyaltyTransaction.count()).toBe(earned);
    const last = changed.body.history.at(-1);
    expect(last).toMatchObject({ type: 'payment_method', data: { from: 'card', to: 'cash' } });

    // The same method again changes nothing; an old version is refused.
    const same = await pay(visit.id, {
      version: changed.body.version,
      paid: true,
      method: 'cash',
    }).expect(200);
    expect(same.body.version).toBe(changed.body.version);
    expectError(
      (await pay(visit.id, { version: paid.body.version, paid: true, method: 'blik' }).expect(409))
        .body,
      'VERSION_CONFLICT',
    );
    // Paid without a method keeps the method it has; null clears it.
    const kept = await pay(visit.id, { version: same.body.version, paid: true }).expect(200);
    expect(kept.body.paymentMethod).toBe('cash');
    const cleared = await pay(visit.id, {
      version: kept.body.version,
      paid: true,
      method: null,
    }).expect(200);
    expect(cleared.body.paymentMethod).toBeNull();

    // A refund takes the method away too.
    const again = await pay(visit.id, {
      version: cleared.body.version,
      paid: true,
      method: 'blik',
    }).expect(200);
    expect(again.body.paymentMethod).toBe('blik');
    const refunded = await pay(visit.id, { version: again.body.version, paid: false }).expect(200);
    expect(refunded.body).toMatchObject({ paidAt: null, paymentMethod: null });
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: visit.id } });
    expect(row.paymentMethod).toBeNull();
  });

  it('a method needs "paid"; unknown methods are refused', async () => {
    const visit = (await walkIn(ago(2)).expect(201)).body;
    expectError(
      (await pay(visit.id, { version: visit.version, paid: false, method: 'cash' }).expect(400))
        .body,
      'VALIDATION_ERROR',
    );
    expectError(
      (await pay(visit.id, { version: visit.version, paid: true, method: 'bitcoin' }).expect(400))
        .body,
      'VALIDATION_ERROR',
    );
    expectError(
      (await walkIn(ago(3), { paymentMethod: 'cash' }).expect(400)).body,
      'VALIDATION_ERROR',
    );
    expect((await detail(visit.id)).paymentMethod).toBeNull();
  });

  it('a walk-in entered as paid keeps how it was paid', async () => {
    const res = await walkIn(ago(1), { paid: true, paymentMethod: 'transfer' }).expect(201);
    expect(res.body).toMatchObject({ paymentMethod: 'transfer' });
    expect(res.body.paidAt).not.toBeNull();
    const paidEvent = res.body.history.find((h: { type: string }) => h.type === 'paid');
    expect(paidEvent.data).toMatchObject({ method: 'transfer' });
  });

  it('a specialist marks the method on own visits only', async () => {
    const own = (await walkIn(ago(2), {}, kasia.auth).expect(201)).body;
    const res = await pay(own.id, { version: own.version, paid: true, method: 'blik' }, kasia.auth);
    expect(res.status).toBe(200);
    expect(res.body.paymentMethod).toBe('blik');
    const olas = (await walkIn(ago(2), {}, owner.auth, olaStaffId).expect(201)).body;
    const refused = await pay(
      olas.id,
      { version: olas.version, paid: true, method: 'cash' },
      kasia.auth,
    );
    expect([403, 404]).toContain(refused.status);
    expect((await detail(olas.id)).paymentMethod).toBeNull();
  });
});
