import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
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

/** Task 14, part 1: reports for the salon owner — visits, no-shows and what clients paid. */

const TZ = 'Europe/Warsaw';
const PHONES: Record<string, string> = {
  'jan@example.com': '+48600000001',
  'ewa@example.com': '+48600000002',
  'piotr@example.com': '+48600000003',
};

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
let today: string;
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
  today = localToday(Date.now(), TZ);
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
  const ids: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [haircutId, beardId] })
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
});

/**
 * A visit booked through the API, then moved straight in the database to a past local day
 * with the given outcome (the API only allows marks in their own time).
 */
async function visit(opts: {
  daysAgo: number;
  serviceId: string;
  staffId: string;
  email: string;
  status: 'completed' | 'no_show' | 'cancelled' | 'confirmed';
  paid?: boolean;
  discountGrosze?: number;
}): Promise<void> {
  const ahead = new Date(zonedToInstant(addDays(today, 2), hour++ * 60, TZ));
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: opts.serviceId,
      staffId: opts.staffId,
      start: ahead.toISOString(),
      allowOutsideHours: true,
      customer: { name: opts.email.split('@')[0], phone: PHONES[opts.email], email: opts.email },
    })
    .expect(201);
  const start = new Date(zonedToInstant(addDays(today, -opts.daysAgo), 12 * 60, TZ));
  await ctx.prisma.appointment.update({
    where: { id: res.body.id },
    data: {
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60_000),
      blockedUntil: new Date(start.getTime() + 30 * 60_000),
      status: opts.status,
      ...(opts.status === 'cancelled' ? { cancelledAt: start, cancelledBy: 'customer' } : {}),
      ...(opts.paid ? { paidAt: start } : {}),
      discountGrosze: opts.discountGrosze ?? 0,
    },
  });
}

const report = (from: string, to: string, auth = owner.auth) =>
  ctx.http().get(`${base}/reports/summary`).query({ from, to }).set(auth);

describe('salon report', () => {
  it('counts visits, no-shows, cancellations and what the clients paid', async () => {
    // Jan came before the period too: not a new client.
    await visit({
      daysAgo: 10,
      serviceId: haircutId,
      staffId: kasiaStaffId,
      email: 'jan@example.com',
      status: 'completed',
      paid: true,
    });
    await visit({
      daysAgo: 5,
      serviceId: haircutId,
      staffId: kasiaStaffId,
      email: 'jan@example.com',
      status: 'completed',
      paid: true,
      discountGrosze: 2000,
    });
    await visit({
      daysAgo: 3,
      serviceId: beardId,
      staffId: kasiaStaffId,
      email: 'jan@example.com',
      status: 'completed',
      paid: true,
    });
    await visit({
      daysAgo: 3,
      serviceId: haircutId,
      staffId: olaStaffId,
      email: 'ewa@example.com',
      status: 'no_show',
    });
    await visit({
      daysAgo: 2,
      serviceId: haircutId,
      staffId: olaStaffId,
      email: 'ewa@example.com',
      status: 'cancelled',
    });
    await visit({
      daysAgo: 2,
      serviceId: beardId,
      staffId: olaStaffId,
      email: 'piotr@example.com',
      status: 'completed',
    });

    const res = await report(addDays(today, -7), addDays(today, -1)).expect(200);
    const shape = registeredResponseSchema('SalonReport').safeParse(res.body);
    expect(shape.error?.issues ?? []).toEqual([]);
    expect(res.body).toMatchObject({
      from: addDays(today, -7),
      to: addDays(today, -1),
      currency: 'PLN',
      totals: {
        appointments: 5,
        completed: 3,
        noShow: 1,
        cancelledByClient: 1,
        cancelledBySalon: 0,
        upcoming: 0,
        online: 0,
        paidVisits: 2,
        revenueGrosze: 10_000,
        discountGrosze: 2000,
        averageTicketGrosze: 5000,
        noShowPercent: 25,
        clients: 2,
        newClients: 1,
      },
    });
    expect(res.body.byStaff).toEqual([
      {
        staffId: kasiaStaffId,
        displayName: 'Kasia',
        completed: 2,
        noShow: 0,
        paidVisits: 2,
        revenueGrosze: 10_000,
      },
      {
        staffId: olaStaffId,
        displayName: 'Ola',
        completed: 1,
        noShow: 1,
        paidVisits: 0,
        revenueGrosze: 0,
      },
    ]);
    expect(res.body.byService).toEqual([
      {
        serviceId: haircutId,
        name: 'Strzyżenie',
        completed: 1,
        paidVisits: 1,
        revenueGrosze: 6000,
      },
      { serviceId: beardId, name: 'Broda', completed: 2, paidVisits: 1, revenueGrosze: 4000 },
    ]);
    expect(res.body.byDay).toHaveLength(7);
    expect(res.body.byDay[2]).toEqual({
      date: addDays(today, -5),
      completed: 1,
      revenueGrosze: 6000,
    });
    expect(res.body.byDay[6]).toEqual({ date: addDays(today, -1), completed: 0, revenueGrosze: 0 });
  });

  it('an empty period has nothing to divide', async () => {
    const res = await report(today, today).expect(200);
    expect(res.body.totals).toMatchObject({
      appointments: 0,
      averageTicketGrosze: null,
      noShowPercent: null,
      newClients: 0,
    });
    expect(res.body.byStaff).toEqual([]);
    expect(res.body.byDay).toEqual([{ date: today, completed: 0, revenueGrosze: 0 }]);
  });

  it('only owners and managers; at most a year; another salon is not found', async () => {
    await report(today, today, kasia.auth).expect(403);
    expectError((await report(addDays(today, -400), today).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await report(today, addDays(today, -1)).expect(400)).body, 'VALIDATION_ERROR');
    const other = await signUp(ctx, 'other@example.com');
    const theirs = await createOrgWithLocation(ctx, other, 'Inny');
    await ctx
      .http()
      .get(`/v1/organizations/${orgId}/locations/${theirs.locationId}/reports/summary`)
      .query({ from: today, to: today })
      .set(owner.auth)
      .expect(404);
  });
});
