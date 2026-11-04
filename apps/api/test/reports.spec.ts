import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/** Task 14, part a: the salon owner's report for a period. */

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let kasiaUser: SignedInUser;
let kasiaMembershipId: string;
let orgId: string;
let locationId: string;
let base: string;
let haircutId: string;
let beardId: string;
let kasiaId: string;
let olaId: string;
let today: string;
let from: string;
let hour = 8;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  hour = 8;
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = async (name: string, priceGrosze: number) =>
    (
      await ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .send({ name, durationMinutes: 30, priceGrosze })
        .expect(201)
    ).body.id as string;
  haircutId = await service('Strzyżenie', 8000);
  beardId = await service('Broda', 5000);
  kasiaUser = await signUp(ctx, 'kasia@example.com');
  const membership = await ctx.prisma.membership.create({
    data: {
      userId: kasiaUser.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
  kasiaMembershipId = membership.id;
  const staff = async (displayName: string) =>
    (
      await ctx
        .http()
        .post(`${base}/staff`)
        .set(owner.auth)
        .send({ displayName, serviceIds: [haircutId, beardId] })
        .expect(201)
    ).body.id as string;
  kasiaId = await staff('Kasia');
  olaId = await staff('Ola');
  await ctx.prisma.staffMember.update({
    where: { id: kasiaId },
    data: { userId: kasiaUser.userId },
  });
  today = localToday(Date.now(), TZ);
  from = addDays(today, -10);
});

interface VisitOptions {
  staffId?: string;
  serviceId?: string;
  email?: string;
  /** Local date of the visit. */
  date: string;
  status: 'completed' | 'no_show' | 'confirmed' | 'cancelled';
  paid?: boolean;
  discountGrosze?: number;
  online?: boolean;
  cancelledBy?: 'customer' | 'salon';
}

/** A visit booked by the salon, then moved to `date` and given its outcome. */
async function visit(o: VisitOptions): Promise<string> {
  const future = new Date(zonedToInstant(addDays(today, 2), hour++ * 30, TZ));
  const booked = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: o.serviceId ?? haircutId,
      staffId: o.staffId ?? kasiaId,
      start: future.toISOString(),
      allowOutsideHours: true,
      customer: { name: 'Jan Nowak', phone: '+48600000002', email: o.email ?? 'jan@example.com' },
    })
    .expect(201);
  const start = new Date(zonedToInstant(o.date, 12 * 60, TZ));
  const end = new Date(start.getTime() + 30 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id: booked.body.id },
    data: {
      startAt: start,
      endAt: end,
      blockedUntil: end,
      status: o.status,
      source: o.online ? 'online' : 'manual',
      discountGrosze: o.discountGrosze ?? 0,
      paidAt: o.paid ? new Date() : null,
      ...(o.status === 'cancelled'
        ? { cancelledAt: new Date(), cancelledBy: o.cancelledBy ?? 'customer' }
        : {}),
    },
  });
  return booked.body.id;
}

const report = (auth = owner.auth, query: object = { from, to: today }) =>
  ctx.http().get(`${base}/reports`).query(query).set(auth);

describe('salon report', () => {
  it('counts visits, revenue, clients, specialists, services and days', async () => {
    const d1 = addDays(today, -5);
    const d2 = addDays(today, -2);
    // Jan came before the period: he is a returning client.
    await visit({ date: addDays(today, -40), status: 'completed', paid: true });
    await visit({ date: d1, status: 'completed', paid: true, online: true });
    await visit({ date: d1, status: 'completed', paid: true, discountGrosze: 2000 });
    await visit({
      date: d2,
      staffId: olaId,
      serviceId: beardId,
      email: 'ewa@example.com',
      status: 'completed',
      paid: true,
    });
    // Came but not paid yet: no revenue.
    await visit({ date: d2, staffId: olaId, email: 'ewa@example.com', status: 'completed' });
    await visit({ date: d2, email: 'adam@example.com', status: 'no_show' });
    await visit({ date: d2, status: 'cancelled', cancelledBy: 'customer', online: true });
    await visit({ date: d2, status: 'cancelled', cancelledBy: 'salon' });
    await visit({ date: today, status: 'confirmed', online: true });
    // Outside the period.
    await visit({ date: addDays(today, -11), status: 'completed', paid: true });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body).toMatchObject({
      from,
      to: today,
      scope: 'location',
      location: { id: locationId, timezone: TZ, currency: 'PLN' },
      totals: {
        visits: 8,
        upcoming: 1,
        completed: 4,
        noShow: 1,
        paid: 3,
        revenueGrosze: 8000 + 6000 + 5000,
        discountGrosze: 2000,
        averageTicketGrosze: Math.round(19000 / 3),
        cancelledByClient: 1,
        cancelledBySalon: 1,
        online: 2,
        clients: 2,
        newClients: 1,
      },
    });
    expect(res.body.staff).toEqual([
      { id: kasiaId, displayName: 'Kasia', completed: 2, noShow: 1, revenueGrosze: 14000, paid: 2 },
      { id: olaId, displayName: 'Ola', completed: 2, noShow: 0, revenueGrosze: 5000, paid: 1 },
    ]);
    expect(res.body.services).toEqual([
      { id: haircutId, name: 'Strzyżenie', completed: 3, noShow: 1, revenueGrosze: 14000, paid: 2 },
      { id: beardId, name: 'Broda', completed: 1, noShow: 0, revenueGrosze: 5000, paid: 1 },
    ]);
    expect(res.body.days).toHaveLength(11);
    expect(res.body.days[0]).toEqual({ date: from, completed: 0, revenueGrosze: 0 });
    expect(res.body.days.find((d: { date: string }) => d.date === d1)).toEqual({
      date: d1,
      completed: 2,
      revenueGrosze: 14000,
    });
    expect(res.body.days.find((d: { date: string }) => d.date === d2)).toEqual({
      date: d2,
      completed: 2,
      revenueGrosze: 5000,
    });
  });

  it('an empty period is all zeros', async () => {
    const res = await report().expect(200);
    expect(res.body.totals).toMatchObject({ visits: 0, revenueGrosze: 0, averageTicketGrosze: 0 });
    expect(res.body.staff).toEqual([]);
    expect(res.body.days).toHaveLength(11);
  });

  it('a specialist sees only their own results, and only with the permission', async () => {
    await visit({ date: addDays(today, -1), status: 'completed', paid: true });
    await visit({ date: addDays(today, -1), staffId: olaId, status: 'completed', paid: true });
    await report(kasiaUser.auth).expect(403);
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.scope).toBe('own');
    expect(own.body.totals).toMatchObject({ completed: 1, revenueGrosze: 8000 });
    expect(own.body.staff.map((s: { id: string }) => s.id)).toEqual([kasiaId]);
  });

  it('other salons and organizations do not exist; long or reversed periods are refused', async () => {
    const stranger = await signUp(ctx, 'other@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    await report(stranger.auth).expect(404);
    await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/locations/${locationId}/reports`)
      .query({ from, to: today })
      .set(stranger.auth)
      .expect(404);
    await report(owner.auth, { from: addDays(today, -366), to: today }).expect(400);
    await report(owner.auth, { from: today, to: from }).expect(400);
    await report(owner.auth, { from: addDays(today, -365), to: today }).expect(200);
  });
});
