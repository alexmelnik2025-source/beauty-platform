import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Task 98: the client card sums up how the client comes — visits that took place, no-shows,
 * cancellations, the first and latest visit — and, for owners and managers, what the paid visits
 * brought. Counted with the same rights as the card's visit history.
 */

const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let ctx: TestContext;
let owner: SignedInUser;
let manager: SignedInUser;
let kasia: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let customersBase: string;
let haircutId: string;
let kasiaId: string;
let tomekId: string;
let customerId: string;

/** On a 5-minute mark, `ms` from now. */
const fromNow = (ms: number): string =>
  new Date(Math.floor((Date.now() + ms) / FIVE_MIN) * FIVE_MIN).toISOString();

async function member(user: SignedInUser, role: 'manager' | 'staff') {
  return ctx.prisma.membership.create({
    data: {
      userId: user.userId,
      organizationId: orgId,
      role,
      locations: { create: [{ locationId }] },
    },
  });
}

let pastCount = 0;

/**
 * A visit entered afterwards as "came" (and paid, unless told otherwise) — the cabinet allows
 * that for the last hours only, so it is moved `daysAgo` back in the database.
 */
async function pastVisit(staffId: string, daysAgo: number, paid = true): Promise<string> {
  pastCount += 1;
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId,
      start: fromNow(-(1 + pastCount) * HOUR),
      customerId,
      alreadyHappened: true,
      paid,
      allowOutsideHours: true,
    })
    .expect(201);
  const visit = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
  const back = (d: Date) => new Date(d.getTime() - daysAgo * DAY);
  await ctx.prisma.appointment.update({
    where: { id: visit.id },
    data: {
      startAt: back(visit.startAt),
      endAt: back(visit.endAt),
      blockedUntil: back(visit.blockedUntil),
    },
  });
  return visit.id;
}

async function futureVisit(staffId: string, days: number): Promise<string> {
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId,
      start: fromNow(days * DAY),
      customerId,
      allowOutsideHours: true,
    })
    .expect(201);
  return res.body.id;
}

const card = (auth: Record<string, string>) =>
  ctx.http().get(`${customersBase}/${customerId}`).set(auth).expect(200);

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  pastCount = 0;
  owner = await signUp(ctx, 'owner@example.com');
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
  const staff = async (displayName: string) =>
    (
      await ctx
        .http()
        .post(`${base}/staff`)
        .set(owner.auth)
        .send({ displayName, serviceIds: [haircutId] })
        .expect(201)
    ).body.id as string;
  kasiaId = await staff('Kasia');
  tomekId = await staff('Tomek');
  manager = await signUp(ctx, 'manager@example.com');
  await member(manager, 'manager');
  kasia = await signUp(ctx, 'kasia@example.com');
  await member(kasia, 'staff');
  await ctx.prisma.staffMember.update({ where: { id: kasiaId }, data: { userId: kasia.userId } });
  customerId = (
    await ctx
      .http()
      .post(customersBase)
      .set(owner.auth)
      .send({ name: 'Jan Nowak', phone: '+48600000002' })
      .expect(201)
  ).body.id;
});

describe('client summary on the card (task 98)', () => {
  it('a new client: zeros, no dates, nothing paid', async () => {
    const res = await card(owner.auth);
    expect(
      registeredResponseSchema('CustomerDetail').safeParse(res.body).error?.issues ?? [],
    ).toEqual([]);
    expect(res.body.summary).toEqual({
      completed: 0,
      noShow: 0,
      cancelledByClient: 0,
      cancelledBySalon: 0,
      upcoming: 0,
      firstVisitAt: null,
      lastVisitAt: null,
      paid: [],
    });
  });

  it('counts visits, no-shows and cancellations; the paid sum is after coupons', async () => {
    const first = await pastVisit(kasiaId, 30);
    await pastVisit(tomekId, 10);
    const latest = await pastVisit(kasiaId, 2, false);
    // A 20 zł coupon on the first visit: it brought 60 zł.
    await ctx.prisma.appointment.update({ where: { id: first }, data: { discountGrosze: 2000 } });
    const missed = await futureVisit(kasiaId, 3);
    await ctx.prisma.appointment.update({
      where: { id: missed },
      data: { status: 'no_show', startAt: new Date(Date.now() - 20 * DAY) },
    });
    for (const [staffId, by] of [
      [kasiaId, 'customer'],
      [tomekId, 'customer'],
      [tomekId, 'salon'],
    ] as const) {
      const id = await futureVisit(staffId, 4);
      await ctx.prisma.appointment.update({
        where: { id },
        data: { status: 'cancelled', cancelledBy: by, cancelledAt: new Date() },
      });
    }
    await futureVisit(tomekId, 5);
    // An unfinished online booking does not count.
    const held = await futureVisit(kasiaId, 6);
    await ctx.prisma.appointment.update({ where: { id: held }, data: { status: 'expired' } });

    const { body } = await card(owner.auth);
    const latestStart = (await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: latest } }))
      .startAt;
    const firstStart = (await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: first } }))
      .startAt;
    expect(body.summary).toEqual({
      completed: 3,
      noShow: 1,
      cancelledByClient: 2,
      cancelledBySalon: 1,
      upcoming: 1,
      firstVisitAt: firstStart.toISOString(),
      lastVisitAt: latestStart.toISOString(),
      paid: [{ currency: 'PLN', amountGrosze: 6000 + 8000 }],
    });
    // The manager of the salon sees the same, money included.
    expect((await card(manager.auth)).body.summary).toEqual(body.summary);
  });

  it('a specialist without the client history counts only own visits and sees no money', async () => {
    await pastVisit(kasiaId, 30);
    await pastVisit(tomekId, 10);
    await pastVisit(tomekId, 5);
    const missed = await futureVisit(kasiaId, 3);
    await ctx.prisma.appointment.update({
      where: { id: missed },
      data: { status: 'no_show', startAt: new Date(Date.now() - 20 * DAY) },
    });
    await ctx.prisma.membership.updateMany({
      where: { userId: kasia.userId },
      data: { permissionOverrides: { viewClientHistory: false } },
    });
    const { body } = await card(kasia.auth);
    expect(body.visits).toHaveLength(2);
    expect(body.summary).toMatchObject({ completed: 1, noShow: 1, upcoming: 0, paid: null });
  });

  it('salons in other currencies are summed separately', async () => {
    const id = await pastVisit(kasiaId, 10);
    const other = await ctx.prisma.location.create({
      data: {
        organizationId: orgId,
        name: 'Barber Praha',
        slug: 'barber-praha',
        addressLine: 'Václavské nám. 1',
        city: 'Praha',
        postalCode: '110 00',
        currency: 'CZK',
      },
    });
    const visit = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });
    const earlier = (d: Date) => new Date(d.getTime() - 3 * DAY);
    await ctx.prisma.appointment.create({
      data: {
        locationId: other.id,
        staffId: visit.staffId,
        serviceId: visit.serviceId,
        customerId,
        status: 'completed',
        source: visit.source,
        startAt: earlier(visit.startAt),
        endAt: earlier(visit.endAt),
        blockedUntil: earlier(visit.blockedUntil),
        priceGrosze: 50000,
        durationMinutes: visit.durationMinutes,
        bufferMinutes: visit.bufferMinutes,
        paidAt: new Date(),
      },
    });
    const { body } = await card(owner.auth);
    expect(body.summary.paid).toEqual([
      { currency: 'CZK', amountGrosze: 50000 },
      { currency: 'PLN', amountGrosze: 8000 },
    ]);
    expect(body.summary.completed).toBe(2);
  });
});
