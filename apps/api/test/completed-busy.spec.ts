import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Task 610: a visit marked "came" the moment it starts keeps the specialist's chair until its
 * planned end. Before, only confirmed bookings and live holds counted as busy, so the rest of a
 * long visit could be booked a second time — by the salon, online and by the waiting list.
 */

const FIVE_MIN = 5 * 60_000;
const MINUTE = 60_000;

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let longServiceId: string;
let shortServiceId: string;
let staffId: string;

/** The latest 5-minute mark not after now. */
const nowMark = (): number => Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN;
const iso = (ms: number): string => new Date(ms).toISOString();

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = (name: string, durationMinutes: number) =>
    ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name, durationMinutes, priceGrosze: 10_000 })
      .expect(201);
  longServiceId = (await service('Koloryzacja', 180)).body.id;
  shortServiceId = (await service('Strzyżenie', 30)).body.id;
  staffId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [longServiceId, shortServiceId] })
      .expect(201)
  ).body.id;
  // Round the clock, so the test does not depend on the time of day it runs at.
  await ctx
    .http()
    .put(`${base}/staff/${staffId}/working-hours`)
    .set(owner.auth)
    .send({
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        intervals: [{ start: '00:00', end: '24:00' }],
      })),
    })
    .expect(200);
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
});

/** A 3-hour visit that started at the last 5-minute mark and is already marked "came". */
async function cameJustNow(): Promise<{ id: string; start: number }> {
  const start = nowMark();
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: longServiceId,
      staffId,
      start: iso(start),
      customer: { name: 'Anna Nowak', phone: '+48600000001', email: 'anna@example.com' },
      alreadyHappened: true,
    })
    .expect(201);
  expect(res.body.status).toBe('completed');
  return { id: res.body.id, start };
}

describe('a visit marked "came" keeps the chair until its planned end', () => {
  it('the salon cannot book another client into the rest of it', async () => {
    const { start } = await cameJustNow();
    const res = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: shortServiceId,
        staffId,
        start: iso(start + 60 * MINUTE),
        customer: { name: 'Jan Kowalski', phone: '+48600000002', email: 'jan@example.com' },
      })
      .expect(409);
    expectError(res.body, 'SLOT_TAKEN');

    // Right after its planned end the chair is free again.
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: shortServiceId,
        staffId,
        start: iso(start + 180 * MINUTE),
        customer: { name: 'Jan Kowalski', phone: '+48600000002', email: 'jan@example.com' },
      })
      .expect(201);
  });

  it('online: the times are not offered and a hold on them is refused', async () => {
    const { start } = await cameJustNow();
    // Inside the visit, on the salon's 30-minute grid.
    const inside = Math.ceil((start + 120 * MINUTE) / (30 * MINUTE)) * (30 * MINUTE);
    const day = new Date(inside).toISOString().slice(0, 10);
    const dayAfter = new Date(inside + 24 * 60 * MINUTE).toISOString().slice(0, 10);
    const slots = (
      await ctx
        .http()
        .get(`/v1/public/locations/${slug}/availability`)
        .query({ serviceId: shortServiceId, staffId, from: day, to: dayAfter })
        .expect(200)
    ).body.slots as { start: string }[];
    const times = slots.map((s) => new Date(s.start).getTime());
    expect(times.some((t) => t < start + 180 * MINUTE)).toBe(false);
    expect(times.length).toBeGreaterThan(0);
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId: shortServiceId, staffId, start: iso(inside) })
      .expect(409);
    expectError(hold.body, 'SLOT_TAKEN');
  });

  it('a time block cannot be put over it without saying so', async () => {
    const { id, start } = await cameJustNow();
    const res = await ctx
      .http()
      .post(`${base}/time-blocks`)
      .set(owner.auth)
      .send({
        staffId,
        start: iso(start + 60 * MINUTE),
        end: iso(start + 90 * MINUTE),
        reason: 'Przerwa',
      })
      .expect(409);
    expectError(res.body, 'APPOINTMENTS_IN_THE_WAY');
    expect(JSON.stringify(res.body)).toContain(id);
  });
});
