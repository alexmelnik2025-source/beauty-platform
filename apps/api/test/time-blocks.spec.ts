import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiterService } from '../src/common/rate-limiter.service';
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

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let serviceId: string;
let kasiaId: string;
let olaId: string;
let day: string;

const at = (hh: number, mm = 0): string =>
  new Date(zonedToInstant(day, hh * 60 + mm, TZ)).toISOString();

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
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  const ids: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [serviceId] })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${staff.body.id}/working-hours`)
      .set(owner.auth)
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      })
      .expect(200);
    ids.push(staff.body.id);
  }
  [kasiaId, olaId] = ids as [string, string];
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

// ── Helpers ───────────────────────────────────────────

const block = (staffId: string | null, from: number, to: number, auth = owner.auth) =>
  ctx
    .http()
    .post(`${base}/time-blocks`)
    .set(auth)
    .send({ staffId, start: at(from), end: at(to), reason: 'Szkolenie' });

const hold = (staffId: string, hh: number, mm = 0) =>
  ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start: at(hh, mm) });

const manual = (staffId: string, hh: number, extra: object = {}) =>
  ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId,
      staffId,
      start: at(hh),
      customer: { name: 'Jan', phone: '+48600000001' },
      ...extra,
    });

const freeTimes = async (staffId: string) =>
  (
    await ctx
      .http()
      .get(`/v1/public/locations/${slug}/availability`)
      .query({ serviceId, staffId, from: day, to: day })
      .expect(200)
  ).body.slots.map((s: { time: string }) => s.time) as string[];

// ── Tests ─────────────────────────────────────────────

describe('a blocked time is not bookable', () => {
  it('one staff member: no slots, online hold refused, salon booking refused', async () => {
    const res = await block(kasiaId, 12, 13).expect(201);
    expect(res.body).toMatchObject({ staffId: kasiaId, time: '12:00', reason: 'Szkolenie' });

    const kasia = await freeTimes(kasiaId);
    // 11:00 + 45 min + 15 min buffer ends at 12:00 → still fine; 11:15 would run into the block.
    expect(kasia).toContain('11:00');
    expect(kasia).not.toContain('11:15');
    expect(kasia).not.toContain('12:00');
    expect(kasia).toContain('13:00');
    expect(await freeTimes(olaId)).toContain('12:00');

    expectError((await hold(kasiaId, 12).expect(409)).body, 'SLOT_TAKEN');
    expectError((await manual(kasiaId, 12).expect(409)).body, 'OUTSIDE_WORKING_HOURS');
    expectError(
      (await manual(kasiaId, 12, { allowOutsideHours: true }).expect(409)).body,
      'SLOT_TAKEN',
    );
    await hold(olaId, 12).expect(201);
  });

  it('the whole location (no staff member): nobody is bookable', async () => {
    await block(null, 12, 14).expect(201);
    expect(await freeTimes(kasiaId)).not.toContain('12:00');
    expect(await freeTimes(olaId)).not.toContain('13:00');
    expectError((await hold(olaId, 13).expect(409)).body, 'SLOT_TAKEN');
  });

  it('moving an appointment onto a block is refused', async () => {
    await block(kasiaId, 12, 13).expect(201);
    const a = await manual(kasiaId, 10).expect(201);
    expectError(
      (
        await ctx
          .http()
          .post(`${base}/appointments/${a.body.id}/reschedule`)
          .set(owner.auth)
          .send({ version: 1, start: at(12), allowOutsideHours: true })
          .expect(409)
      ).body,
      'SLOT_TAKEN',
    );
  });
});

describe('a block never covers a live appointment', () => {
  it('refuses with the appointments in the way', async () => {
    const a = await manual(kasiaId, 12).expect(201);
    const res = await block(kasiaId, 11, 13).expect(409);
    expectError(res.body, 'APPOINTMENTS_IN_THE_WAY');
    expect(res.body.error.details).toEqual([{ path: 'appointmentId', message: a.body.id }]);
    // The appointment occupies 12:00–13:00 (45 min + 15 min buffer): from 13:00 is free.
    await block(kasiaId, 13, 14).expect(201);
    await block(null, 11, 13).expect(409);
    await block(olaId, 11, 13).expect(201);
  });

  it('an expired hold is not in the way', async () => {
    const h = await hold(kasiaId, 12).expect(201);
    await ctx.prisma
      .$executeRaw`UPDATE appointment SET hold_expires_at = now() - interval '1 second' WHERE id = ${h.body.holdId}::uuid`;
    await block(kasiaId, 12, 13).expect(201);
  });

  it('cancelled appointments are not in the way', async () => {
    const a = await manual(kasiaId, 12).expect(201);
    await ctx
      .http()
      .post(`${base}/appointments/${a.body.id}/cancel`)
      .set(owner.auth)
      .send({ version: 1, reason: 'Klient prosił' })
      .expect(200);
    await block(kasiaId, 12, 13).expect(201);
  });

  it('moving a block onto an appointment is refused; stale version → 409', async () => {
    await manual(kasiaId, 15).expect(201);
    const b = await block(kasiaId, 12, 13).expect(201);
    expectError(
      (
        await ctx
          .http()
          .patch(`${base}/time-blocks/${b.body.id}`)
          .set(owner.auth)
          .send({ version: 1, start: at(15), end: at(16) })
          .expect(409)
      ).body,
      'APPOINTMENTS_IN_THE_WAY',
    );
    await ctx
      .http()
      .patch(`${base}/time-blocks/${b.body.id}`)
      .set(owner.auth)
      .send({ version: 1, start: at(10), end: at(11), reason: 'Lunch' })
      .expect(200);
    expectError(
      (
        await ctx
          .http()
          .patch(`${base}/time-blocks/${b.body.id}`)
          .set(owner.auth)
          .send({ version: 1, reason: 'Stale' })
          .expect(409)
      ).body,
      'VERSION_CONFLICT',
    );
  });

  it('removing a block frees the time and hides it from the list', async () => {
    const b = await block(kasiaId, 12, 13).expect(201);
    await ctx.http().delete(`${base}/time-blocks/${b.body.id}`).set(owner.auth).expect(204);
    expect(await freeTimes(kasiaId)).toContain('12:00');
    const list = await ctx
      .http()
      .get(`${base}/time-blocks`)
      .query({ from: day, to: day })
      .set(owner.auth)
      .expect(200);
    expect(list.body).toEqual([]);
    await ctx.http().delete(`${base}/time-blocks/${b.body.id}`).set(owner.auth).expect(404);
  });

  it('rejects an end before the start and times off the 5-minute grid', async () => {
    await block(kasiaId, 13, 12).expect(400);
    await ctx
      .http()
      .post(`${base}/time-blocks`)
      .set(owner.auth)
      .send({ staffId: kasiaId, start: at(12, 3), end: at(13) })
      .expect(400);
  });
});

describe('simultaneous block and bookings', { timeout: 20_000 }, () => {
  beforeEach(() => {
    ctx.app.get(RateLimiterService).enabled = false;
  });

  it('a block and 10 holds on the same time: never both', async () => {
    for (let round = 0; round < 3; round += 1) {
      const hh = 10 + round * 2;
      const results = await Promise.all([
        block(kasiaId, hh, hh + 1),
        ...Array.from({ length: 10 }, () => hold(kasiaId, hh)),
      ]);
      const [blockRes, ...holds] = results;
      const heldCount = holds.filter((r) => r.status === 201).length;
      if (blockRes!.status === 201) {
        expect(heldCount).toBe(0);
      } else {
        expectError(blockRes!.body, 'APPOINTMENTS_IN_THE_WAY');
        expect(heldCount).toBe(1);
      }
    }
  });

  it('a whole-location block and holds for two staff members: never both', async () => {
    const results = await Promise.all([
      block(null, 10, 11),
      ...Array.from({ length: 5 }, () => hold(kasiaId, 10)),
      ...Array.from({ length: 5 }, () => hold(olaId, 10)),
    ]);
    const [blockRes, ...holds] = results;
    const heldCount = holds.filter((r) => r.status === 201).length;
    if (blockRes!.status === 201) expect(heldCount).toBe(0);
    else expect(heldCount).toBeGreaterThan(0);
  });
});

describe('staff members and blocks', () => {
  let kasia: SignedInUser;
  let membershipId: string;

  beforeEach(async () => {
    kasia = await signUp(ctx, 'kasia@example.com');
    const membership = await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    membershipId = membership.id;
    await ctx.prisma.staffMember.update({ where: { id: kasiaId }, data: { userId: kasia.userId } });
  });

  it('by default may not block time', async () => {
    await block(kasiaId, 12, 13, kasia.auth).expect(403);
  });

  it('with blockOwnTime: only own time, never the whole location or a colleague', async () => {
    await ctx
      .http()
      .put(`/v1/organizations/${orgId}/members/${membershipId}/permissions`)
      .set(owner.auth)
      .send({ version: 1, staffCategoryId: null, overrides: { blockOwnTime: true } })
      .expect(200);
    await block(kasiaId, 12, 13, kasia.auth).expect(201);
    await block(olaId, 12, 13, kasia.auth).expect(403);
    await block(null, 14, 15, kasia.auth).expect(403);
  });

  it('sees own and whole-location blocks, not a colleague’s', async () => {
    await block(kasiaId, 10, 11).expect(201);
    await block(olaId, 10, 11).expect(201);
    await block(null, 16, 17).expect(201);
    const list = await ctx
      .http()
      .get(`${base}/time-blocks`)
      .query({ from: day, to: day })
      .set(kasia.auth)
      .expect(200);
    expect(list.body.map((b: { staffId: string | null }) => b.staffId)).toEqual([kasiaId, null]);
  });
});
