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
 * Task 229: the tip the client left — only a note the staff sets on a visit that took place;
 * no payment systems, not part of the revenue. Shown on the visit, in the report and the CSV.
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
});

const tip = (id: string, body: Record<string, unknown>, auth = owner.auth) =>
  ctx.http().put(`${base}/appointments/${id}/tip`).set(auth).send(body);

const detail = async (id: string, auth = owner.auth) =>
  (await ctx.http().get(`${base}/appointments/${id}`).set(auth).expect(200)).body;

describe('tips (task 229)', () => {
  it('is noted on a visit that took place, changed, cleared, and kept in the history', async () => {
    const visit = (await walkIn(ago(2)).expect(201)).body;
    expect(visit.tipGrosze).toBe(0);

    const noted = await tip(visit.id, { version: visit.version, tipGrosze: 1500 }).expect(200);
    const parsed = registeredResponseSchema('AppointmentDetail').safeParse(noted.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(noted.body.tipGrosze).toBe(1500);
    expect(noted.body.version).toBe(visit.version + 1);
    expect(noted.body.history.at(-1)).toMatchObject({
      type: 'tip',
      data: { from: 0, to: 1500 },
    });
    // Not part of the price; the visit does not become paid.
    expect(noted.body).toMatchObject({ priceGrosze: 8000, paidAt: null });

    // The same amount again changes nothing; an old version is refused.
    const same = await tip(visit.id, { version: noted.body.version, tipGrosze: 1500 }).expect(200);
    expect(same.body.version).toBe(noted.body.version);
    expectError(
      (await tip(visit.id, { version: visit.version, tipGrosze: 2000 }).expect(409)).body,
      'VERSION_CONFLICT',
    );

    const changed = await tip(visit.id, { version: same.body.version, tipGrosze: 2000 }).expect(
      200,
    );
    expect(changed.body.tipGrosze).toBe(2000);
    const cleared = await tip(visit.id, { version: changed.body.version, tipGrosze: 0 }).expect(
      200,
    );
    expect(cleared.body.tipGrosze).toBe(0);
    expect(cleared.body.history.at(-1)).toMatchObject({
      type: 'tip',
      data: { from: 2000, to: 0 },
    });
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: visit.id } });
    expect(row.tipGrosze).toBe(0);
  });

  it('only on a visit that took place; negative, fractional and huge amounts are refused', async () => {
    const booked = (
      await ctx
        .http()
        .post(`${base}/appointments`)
        .set(owner.auth)
        .send({
          serviceId: haircutId,
          staffId: kasiaStaffId,
          start: ago(-26),
          allowOutsideHours: true,
          customer: { name: 'Jan Nowak', phone: '+48600000002', email: 'jan@example.com' },
        })
        .expect(201)
    ).body;
    expectError(
      (await tip(booked.id, { version: booked.version, tipGrosze: 1000 }).expect(409)).body,
      'NOT_COMPLETED',
    );
    const visit = (await walkIn(ago(2)).expect(201)).body;
    for (const tipGrosze of [-1, 10.5, 10_000_001, '1000']) {
      expectError(
        (await tip(visit.id, { version: visit.version, tipGrosze }).expect(400)).body,
        'VALIDATION_ERROR',
      );
    }
    expect((await detail(visit.id)).tipGrosze).toBe(0);
  });

  it('a specialist notes tips on own visits only; other salons do not exist', async () => {
    const own = (await walkIn(ago(2), {}, kasia.auth).expect(201)).body;
    const res = await tip(own.id, { version: own.version, tipGrosze: 500 }, kasia.auth);
    expect(res.status).toBe(200);
    expect(res.body.tipGrosze).toBe(500);
    const olas = (await walkIn(ago(2), {}, owner.auth, olaStaffId).expect(201)).body;
    const refused = await tip(olas.id, { version: olas.version, tipGrosze: 500 }, kasia.auth);
    expect([403, 404]).toContain(refused.status);
    expect((await detail(olas.id)).tipGrosze).toBe(0);

    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Other');
    await ctx
      .http()
      .put(
        `/v1/organizations/${other.orgId}/locations/${other.locationId}/appointments/${own.id}/tip`,
      )
      .set(stranger.auth)
      .send({ version: res.body.version, tipGrosze: 9999 })
      .expect(404);
    expect((await detail(own.id)).tipGrosze).toBe(500);
  });
});
