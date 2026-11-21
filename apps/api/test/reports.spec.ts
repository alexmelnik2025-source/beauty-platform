import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { occupancy } from '../src/reports/occupancy';
import { cancelNotice, discounts, leadTime } from '../src/reports/reports.service';
import { visitsCsv } from '../src/reports/visits-csv';
import { addDays, isoWeekday, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
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
  /** Task 227: how it was paid. */
  method?: 'cash' | 'card' | 'blik' | 'transfer' | 'other';
  discountGrosze?: number;
  /** Task 229: the tip the client left. */
  tipGrosze?: number;
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
      paymentMethod: o.paid ? (o.method ?? null) : null,
      tipGrosze: o.tipGrosze ?? 0,
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
    // Task 219: cancellations by the specialist and the service of the cancelled visit.
    expect(res.body.staff).toEqual([
      {
        id: kasiaId,
        displayName: 'Kasia',
        completed: 2,
        noShow: 1,
        revenueGrosze: 14000,
        paid: 2,
        cancelledByClient: 1,
        cancelledBySalon: 1,
        commissionPercent: null,
        commissionGrosze: null,
      },
      {
        id: olaId,
        displayName: 'Ola',
        completed: 2,
        noShow: 0,
        revenueGrosze: 5000,
        paid: 1,
        cancelledByClient: 0,
        cancelledBySalon: 0,
        commissionPercent: null,
        commissionGrosze: null,
      },
    ]);
    // Task 215: the clients who brought the most, names only (no phone or e-mail).
    const customers = await ctx.prisma.customer.findMany({ select: { id: true, email: true } });
    const idOf = (email: string) => customers.find((c) => c.email === email)!.id;
    expect(res.body.topClients).toEqual([
      { id: idOf('jan@example.com'), name: 'Jan Nowak', completed: 2, revenueGrosze: 14000 },
      { id: idOf('ewa@example.com'), name: 'Jan Nowak', completed: 2, revenueGrosze: 5000 },
    ]);
    expect(JSON.stringify(res.body.topClients)).not.toMatch(/@|\+48/);
    // Task 218: Jan (last came on d1 at Kasia) has booked today; Ewa (d2 at Ola) has not.
    expect(res.body.rebooking).toEqual({
      clients: 2,
      rebooked: 1,
      percent: 50,
      staff: [
        { id: kasiaId, displayName: 'Kasia', clients: 1, rebooked: 1, percent: 100 },
        { id: olaId, displayName: 'Ola', clients: 1, rebooked: 0, percent: 0 },
      ],
    });
    expect(res.body.services).toEqual([
      {
        id: haircutId,
        name: 'Strzyżenie',
        completed: 3,
        noShow: 1,
        revenueGrosze: 14000,
        paid: 2,
        cancelledByClient: 1,
        cancelledBySalon: 1,
      },
      {
        id: beardId,
        name: 'Broda',
        completed: 1,
        noShow: 0,
        revenueGrosze: 5000,
        paid: 1,
        cancelledByClient: 0,
        cancelledBySalon: 0,
      },
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
    // Task 31: Monday to Sunday, and the 11 days before the period to compare with.
    const weekdays = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      completed: 0,
      noShow: 0,
      revenueGrosze: 0,
    }));
    Object.assign(weekdays[isoWeekday(d1) - 1]!, { completed: 2, revenueGrosze: 14000 });
    Object.assign(weekdays[isoWeekday(d2) - 1]!, { completed: 2, noShow: 1, revenueGrosze: 5000 });
    expect(res.body.weekdays).toEqual(weekdays);
    // Task 216: when visits start (every visit here is at 12:00), cancelled ones left out.
    expect(res.body.busyHours).toEqual(
      [
        { weekday: isoWeekday(d1), hour: 12, visits: 2 },
        { weekday: isoWeekday(d2), hour: 12, visits: 3 },
        { weekday: isoWeekday(today), hour: 12, visits: 1 },
      ].sort((a, b) => a.weekday - b.weekday),
    );
    expect(res.body.previous).toEqual({
      from: addDays(from, -11),
      to: addDays(from, -1),
      completed: 1,
      noShow: 0,
      paid: 1,
      revenueGrosze: 8000,
      averageTicketGrosze: 8000,
      clients: 1,
    });
  });

  it('an empty period is all zeros', async () => {
    const res = await report().expect(200);
    expect(res.body.totals).toMatchObject({ visits: 0, revenueGrosze: 0, averageTicketGrosze: 0 });
    expect(res.body.staff).toEqual([]);
    expect(res.body.categories).toEqual([]);
    expect(res.body.days).toHaveLength(11);
    expect(res.body.tips).toEqual({ totalGrosze: 0, visits: 0, staff: [] });
    expect(res.body.marketing).toMatchObject({ clients: 0, consented: 0, percent: 0 });
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
    expect(own.body.tips.staff).toEqual([]);
    // The salon's best clients are not in a specialist's own report (task 215).
    expect(own.body.topClients).toEqual([]);
    // Task 218: only Kasia's own clients (Jan has no later visit).
    expect(own.body.rebooking).toEqual({
      clients: 1,
      rebooked: 0,
      percent: 0,
      staff: [{ id: kasiaId, displayName: 'Kasia', clients: 1, rebooked: 0, percent: 0 }],
    });
  });

  it('"Kolejna wizyta": a later visit at any specialist counts, a cancelled one does not (task 218)', async () => {
    // Jan: came at Kasia, then booked at Ola after the period.
    await visit({ date: addDays(today, -3), status: 'completed' });
    await visit({ date: addDays(today, 5), staffId: olaId, status: 'confirmed' });
    // Ewa: came twice at Ola; the later one is her last visit, she cancelled the next one.
    await visit({
      date: addDays(today, -6),
      staffId: olaId,
      email: 'ewa@example.com',
      status: 'completed',
    });
    await visit({
      date: addDays(today, -2),
      staffId: olaId,
      email: 'ewa@example.com',
      status: 'completed',
    });
    await visit({ date: addDays(today, 3), email: 'ewa@example.com', status: 'cancelled' });
    // Adam: came at Kasia and did not come to the next one — he still booked it.
    await visit({ date: addDays(today, -4), email: 'adam@example.com', status: 'completed' });
    await visit({ date: addDays(today, -1), email: 'adam@example.com', status: 'no_show' });

    const res = await report().expect(200);
    expect(res.body.rebooking).toEqual({
      clients: 3,
      rebooked: 2,
      percent: 67,
      staff: [
        { id: kasiaId, displayName: 'Kasia', clients: 2, rebooked: 2, percent: 100 },
        { id: olaId, displayName: 'Ola', clients: 1, rebooked: 0, percent: 0 },
      ],
    });
    expect(JSON.stringify(res.body.rebooking)).not.toMatch(/Jan|@/);
  });

  it('"Zgody na wiadomości": consents of the clients who came, counts only (task 244)', async () => {
    await visit({ date: addDays(today, -3), status: 'completed' }); // Jan
    await visit({ date: addDays(today, -2), email: 'ewa@example.com', status: 'completed' });
    await visit({ date: addDays(today, -2), email: 'adam@example.com', status: 'completed' });
    await visit({ date: addDays(today, -1), email: 'ola@example.com', status: 'no_show' });
    const id = async (email: string) =>
      (await ctx.prisma.customer.findFirstOrThrow({ where: { organizationId: orgId, email } })).id;
    const jan = await id('jan@example.com');
    const ewa = await id('ewa@example.com');
    const adam = await id('adam@example.com');
    const ola = await id('ola@example.com');
    const longAgo = new Date(zonedToInstant(addDays(today, -60), 12 * 60, TZ));
    const recently = new Date(zonedToInstant(addDays(today, -2), 12 * 60, TZ));
    await ctx.prisma.consentRecord.createMany({
      data: [
        // Jan said yes long ago and again at a booking in the period: consented, not new.
        { customerId: jan, type: 'marketing', version: 't', granted: true, createdAt: longAgo },
        { customerId: jan, type: 'marketing', version: 't', granted: true, createdAt: recently },
        // Ewa said yes for the first time in the period.
        { customerId: ewa, type: 'marketing', version: 't', granted: true, createdAt: recently },
        // Adam said yes and then unsubscribed.
        { customerId: adam, type: 'marketing', version: 't', granted: true, createdAt: longAgo },
        { customerId: adam, type: 'marketing', version: 't', granted: false, createdAt: recently },
        // Ola did not come: she is not counted.
        { customerId: ola, type: 'marketing', version: 't', granted: true, createdAt: recently },
      ],
    });

    const res = await report().expect(200);
    expect(res.body.marketing).toEqual({
      clients: 3,
      consented: 2,
      percent: 67,
      newInPeriod: 1,
      unsubscribed: 1,
    });

    // A specialist's own report: zeros — consents go with the client's contacts.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.marketing).toEqual({
      clients: 0,
      consented: 0,
      percent: 0,
      newInPeriod: 0,
      unsubscribed: 0,
    });
  });

  it('"Nowi klienci — czy wrócili": new clients who came again or booked (task 246)', async () => {
    // Jan came before the period: he is not new.
    await visit({ date: addDays(today, -30), status: 'completed' });
    await visit({ date: addDays(today, -3), status: 'completed' });
    // Ewa: new at Ola, came again (at Kasia).
    await visit({
      date: addDays(today, -6),
      staffId: olaId,
      email: 'ewa@example.com',
      status: 'completed',
    });
    await visit({ date: addDays(today, -2), email: 'ewa@example.com', status: 'completed' });
    // Adam: new at Kasia, has a booked visit.
    await visit({ date: addDays(today, -5), email: 'adam@example.com', status: 'completed' });
    await visit({ date: addDays(today, 3), email: 'adam@example.com', status: 'confirmed' });
    // Piotr: new at Kasia (two services that day), cancelled the next one, missed another.
    await visit({ date: addDays(today, -4), email: 'piotr@example.com', status: 'completed' });
    await visit({
      date: addDays(today, -4),
      serviceId: beardId,
      email: 'piotr@example.com',
      status: 'completed',
    });
    await visit({ date: addDays(today, 2), email: 'piotr@example.com', status: 'cancelled' });
    await visit({ date: addDays(today, -1), email: 'piotr@example.com', status: 'no_show' });

    const res = await report().expect(200);
    expect(res.body.totals.newClients).toBe(3);
    expect(res.body.newcomers).toEqual({
      clients: 3,
      returned: 1,
      booked: 1,
      percent: 67,
      staff: [
        { id: kasiaId, displayName: 'Kasia', clients: 2, returned: 0, booked: 1 },
        { id: olaId, displayName: 'Ola', clients: 1, returned: 1, booked: 0 },
      ],
    });
    expect(JSON.stringify(res.body.newcomers)).not.toMatch(/Jan|Ewa|@/);

    // A specialist's own report: only the new clients of her own visits.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.newcomers).toEqual({
      clients: 2,
      returned: 0,
      booked: 1,
      percent: 50,
      staff: [{ id: kasiaId, displayName: 'Kasia', clients: 2, returned: 0, booked: 1 }],
    });
  });

  it('"Co ile dni wracają klienci": days between visits in a row, by specialist (task 247)', async () => {
    // Jan: before the period at Kasia, then 21 days later at Kasia, then 7 days later at Ola.
    await visit({ date: addDays(today, -30), status: 'completed' });
    await visit({ date: addDays(today, -9), status: 'completed' });
    await visit({ date: addDays(today, -2), staffId: olaId, status: 'completed' });
    // Ewa: two services on one day (not a return), then 5 days later at Ola; a missed visit.
    await visit({
      date: addDays(today, -6),
      staffId: olaId,
      email: 'ewa@example.com',
      status: 'completed',
    });
    await visit({
      date: addDays(today, -6),
      serviceId: beardId,
      email: 'ewa@example.com',
      status: 'completed',
    });
    await visit({
      date: addDays(today, -1),
      staffId: olaId,
      email: 'ewa@example.com',
      status: 'completed',
    });
    await visit({ date: addDays(today, -4), email: 'ewa@example.com', status: 'no_show' });
    // Adam came once.
    await visit({ date: addDays(today, -3), email: 'adam@example.com', status: 'completed' });

    const res = await report().expect(200);
    expect(res.body.returnInterval).toEqual({
      intervals: 3,
      averageDays: 11,
      medianDays: 7,
      staff: [
        { id: olaId, displayName: 'Ola', intervals: 2, averageDays: 6, medianDays: 6 },
        { id: kasiaId, displayName: 'Kasia', intervals: 1, averageDays: 21, medianDays: 21 },
      ],
    });

    // A specialist's own report: only the returns to her.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.returnInterval).toEqual({
      intervals: 1,
      averageDays: 21,
      medianDays: 21,
      staff: [{ id: kasiaId, displayName: 'Kasia', intervals: 1, averageDays: 21, medianDays: 21 }],
    });
  });

  it('"Pora wrócić": regular clients past their usual break, today whatever the period (task 263)', async () => {
    // Jan: every 20 days, last 30 days ago — due 10 days ago.
    for (const days of [70, 50, 30]) {
      await visit({ date: addDays(today, -days), status: 'completed' });
    }
    // Ewa: due as well, but booked again.
    for (const days of [30, 20, 10]) {
      await visit({ date: addDays(today, -days), email: 'ewa@example.com', status: 'completed' });
    }
    await visit({ date: addDays(today, 3), email: 'ewa@example.com', status: 'confirmed' });
    // Adam: two visits are not a habit yet.
    for (const days of [60, 40]) {
      await visit({ date: addDays(today, -days), email: 'adam@example.com', status: 'completed' });
    }

    expect((await report().expect(200)).body.overdueClients).toBe(1);
    // Any period: the count is as of today.
    const lastYear = { from: addDays(today, -400), to: addDays(today, -380) };
    expect((await report(owner.auth, lastYear).expect(200)).body.overdueClients).toBe(1);

    // Not in a specialist's own report.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    expect((await report(kasiaUser.auth).expect(200)).body.overdueClients).toBe(0);
  });

  it('"Nie przyszli": clients who missed a visit in the last year, today whatever the period (task 265)', async () => {
    // Jan did not come twice — he counts once.
    await visit({ date: addDays(today, -40), status: 'no_show' });
    await visit({ date: addDays(today, -5), status: 'no_show' });
    // Ewa did not come, but more than a year ago.
    await visit({ date: addDays(today, -400), email: 'ewa@example.com', status: 'no_show' });
    // Adam always comes.
    await visit({ date: addDays(today, -3), email: 'adam@example.com', status: 'completed' });

    expect((await report().expect(200)).body.noShowClients).toBe(1);
    const lastYear = { from: addDays(today, -400), to: addDays(today, -380) };
    expect((await report(owner.auth, lastYear).expect(200)).body.noShowClients).toBe(1);

    // Not in a specialist's own report.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    expect((await report(kasiaUser.auth).expect(200)).body.noShowClients).toBe(0);
  });

  it('"Byli tylko raz": clients who came once and did not come back, today whatever the period (task 271)', async () => {
    // Jan came once, 40 days ago (two services that day are one visit).
    await visit({ date: addDays(today, -40), status: 'completed' });
    await visit({ date: addDays(today, -40), status: 'completed' });
    // Ewa came twice.
    await visit({ date: addDays(today, -90), email: 'ewa@example.com', status: 'completed' });
    await visit({ date: addDays(today, -60), email: 'ewa@example.com', status: 'completed' });
    // Adam came once, 50 days ago, but is booked again.
    await visit({ date: addDays(today, -50), email: 'adam@example.com', status: 'completed' });
    await visit({ date: addDays(today, 5), email: 'adam@example.com', status: 'confirmed' });
    // Ola came once, but only 10 days ago — still new.
    await visit({ date: addDays(today, -10), email: 'ola@example.com', status: 'completed' });

    expect((await report().expect(200)).body.onceClients).toBe(1);
    const lastYear = { from: addDays(today, -400), to: addDays(today, -380) };
    expect((await report(owner.auth, lastYear).expect(200)).body.onceClients).toBe(1);

    // Not in a specialist's own report.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    expect((await report(kasiaUser.auth).expect(200)).body.onceClients).toBe(0);
  });

  it('"Obłożenie": working time by the schedule, the part visits took and revenue an hour (tasks 141, 299)', async () => {
    const d1 = addDays(today, -5);
    const d2 = addDays(today, -2);
    // Kasia works 10:00–18:00 every day; on d2 only 12:00–14:00 (special day).
    await ctx.prisma.workingHours.createMany({
      data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        staffId: kasiaId,
        weekday,
        startMinute: 10 * 60,
        endMinute: 18 * 60,
      })),
    });
    await ctx.prisma.workingHoursOverride.create({
      data: {
        staffId: kasiaId,
        date: new Date(`${d2}T00:00:00Z`),
        startMinute: 12 * 60,
        endMinute: 14 * 60,
      },
    });
    // A day of vacation and a blocked hour for the whole salon on d1, 16:00–17:00.
    const vacation = addDays(today, -7);
    await ctx.prisma.timeOff.create({
      data: {
        staffId: kasiaId,
        startsAt: new Date(zonedToInstant(vacation, 0, TZ)),
        endsAt: new Date(zonedToInstant(addDays(vacation, 1), 0, TZ)),
      },
    });
    await ctx.prisma.timeBlock.create({
      data: {
        locationId,
        startAt: new Date(zonedToInstant(d1, 16 * 60, TZ)),
        endAt: new Date(zonedToInstant(d1, 17 * 60, TZ)),
      },
    });
    // Visits at 12:00 for 30 minutes: came, did not come, cancelled (does not count).
    await visit({ date: d1, status: 'completed', paid: true });
    await visit({ date: d2, status: 'no_show' });
    await visit({ date: d2, status: 'cancelled' });
    // Ola has no schedule but a visit: she is listed with 0%.
    await visit({ date: d1, staffId: olaId, status: 'completed' });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    // 11 days: 10 × 8 h + 2 h (special day) − 8 h (vacation) − 1 h (blocked) = 73 h.
    const work = (10 * 8 + 2 - 8 - 1) * 60;
    // Task 299: the paid haircut (80 zł) for 73 working hours ≈ 1,10 zł an hour.
    const perHour = Math.round((8000 * 60) / work);
    expect(res.body.occupancy).toEqual({
      workMinutes: work,
      bookedMinutes: 60,
      percent: Math.round((60 / work) * 100),
      revenuePerHourGrosze: perHour,
      staff: [
        {
          id: kasiaId,
          displayName: 'Kasia',
          workMinutes: work,
          bookedMinutes: 60,
          percent: Math.round((60 / work) * 100),
          revenuePerHourGrosze: perHour,
        },
        {
          id: olaId,
          displayName: 'Ola',
          workMinutes: 0,
          bookedMinutes: 0,
          percent: 0,
          revenuePerHourGrosze: null,
        },
      ],
    });

    // A specialist with their own report sees only their own line.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.occupancy.staff.map((s: { id: string }) => s.id)).toEqual([kasiaId]);
    expect(own.body.occupancy.workMinutes).toBe(work);
    expect(own.body.occupancy.revenuePerHourGrosze).toBe(perHour);
  });

  it('ratings: reviews of the period by stars and specialist; a specialist sees only own', async () => {
    const review = async (o: VisitOptions, rating: number) => {
      const appointmentId = await visit(o);
      const staffId = o.staffId ?? kasiaId;
      await ctx.prisma.visitReview.create({
        data: { appointmentId, locationId, staffId, rating },
      });
    };
    const d1 = addDays(today, -5);
    await review({ date: d1, status: 'completed' }, 5);
    await review({ date: d1, status: 'completed' }, 4);
    await review({ date: d1, staffId: olaId, status: 'completed' }, 5);
    await review({ date: d1, staffId: olaId, status: 'completed' }, 5);
    await review({ date: d1, staffId: olaId, serviceId: beardId, status: 'completed' }, 2);
    // A review of a visit before the period does not count.
    await review({ date: addDays(today, -40), status: 'completed' }, 1);

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.ratings).toEqual({
      reviews: 5,
      average: 4.2,
      stars: [0, 1, 0, 1, 3],
      staff: [
        { id: kasiaId, displayName: 'Kasia', reviews: 2, average: 4.5 },
        { id: olaId, displayName: 'Ola', reviews: 3, average: 4 },
      ],
      // Task 421: the same by service, best rated first.
      services: [
        { id: haircutId, name: 'Strzyżenie', reviews: 4, average: 4.8 },
        { id: beardId, name: 'Broda', reviews: 1, average: 2 },
      ],
    });

    // A specialist with their own report sees only the reviews of their own visits.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.ratings).toEqual({
      reviews: 2,
      average: 4.5,
      stars: [0, 0, 0, 1, 1],
      staff: [{ id: kasiaId, displayName: 'Kasia', reviews: 2, average: 4.5 }],
      services: [{ id: haircutId, name: 'Strzyżenie', reviews: 2, average: 4.5 }],
    });

    // No reviews in a period: no average.
    const empty = await report(owner.auth, { from: addDays(today, -60), to: addDays(today, -50) });
    expect(empty.body.ratings).toEqual({
      reviews: 0,
      average: null,
      stars: [0, 0, 0, 0, 0],
      staff: [],
      services: [],
    });
  });

  it('occupancy: overlapping visits count once, visits outside hours do not count', () => {
    const day = '2026-11-02'; // Monday
    const at = (minute: number) => zonedToInstant(day, minute, TZ);
    const result = occupancy(
      {
        weekly: new Map([[1, [{ startMinute: 9 * 60, endMinute: 17 * 60 }]]]),
        overrides: new Map(),
        away: [{ start: at(12 * 60), end: at(13 * 60) }],
      },
      [
        { start: at(9 * 60), end: at(10 * 60) },
        { start: at(9 * 60 + 30), end: at(10 * 60 + 30) },
        // Over lunch (blocked) and after closing: only working minutes count.
        { start: at(12 * 60 + 30), end: at(13 * 60 + 30) },
        { start: at(17 * 60), end: at(18 * 60) },
      ],
      day,
      '2026-11-03',
      TZ,
    );
    // Monday 9–17 minus lunch; Tuesday has no hours.
    expect(result).toEqual({ workMinutes: 7 * 60, bookedMinutes: 90 + 30 });
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
  it('"Sposoby płatności": paid visits by payment method, not said last (task 227)', async () => {
    const d1 = addDays(today, -4);
    await visit({ date: d1, status: 'completed', paid: true, method: 'cash' });
    await visit({
      date: d1,
      status: 'completed',
      paid: true,
      method: 'card',
      discountGrosze: 1000,
    });
    await visit({ date: d1, status: 'completed', paid: true, method: 'card' });
    await visit({ date: d1, status: 'completed', paid: true });
    // Not paid, or not taken place: not in the list.
    await visit({ date: d1, status: 'completed' });
    await visit({ date: d1, status: 'no_show' });
    const res = await report().expect(200);
    expect(res.body.payments).toEqual([
      { method: 'card', paid: 2, revenueGrosze: 15000 },
      { method: 'cash', paid: 1, revenueGrosze: 8000 },
      { method: 'unknown', paid: 1, revenueGrosze: 8000 },
    ]);
    const sum = res.body.payments.reduce(
      (total: number, p: { revenueGrosze: number }) => total + p.revenueGrosze,
      0,
    );
    expect(sum).toBe(res.body.totals.revenueGrosze);
    const empty = await report(owner.auth, { from: today, to: today }).expect(200);
    expect(empty.body.payments).toEqual([]);
  });

  it('"Kategorie usług": the same by price-list category, without a category last by revenue (task 256)', async () => {
    const d1 = addDays(today, -3);
    // No category anywhere: nothing to group by.
    await visit({ date: d1, status: 'completed', paid: true });
    expect((await report().expect(200)).body.categories).toEqual([]);

    const hair = await ctx
      .http()
      .post(`${base}/service-categories`)
      .set(owner.auth)
      .send({ name: 'Włosy' })
      .expect(201);
    await ctx
      .http()
      .patch(`${base}/services/${haircutId}`)
      .set(owner.auth)
      .send({ version: 1, categoryId: hair.body.id })
      .expect(200);
    await visit({ date: d1, status: 'no_show' });
    await visit({ date: d1, status: 'cancelled', cancelledBy: 'salon' });
    // Broda has no category.
    await visit({ date: d1, serviceId: beardId, staffId: olaId, status: 'completed', paid: true });
    await visit({ date: d1, serviceId: beardId, staffId: olaId, status: 'completed' });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.categories).toEqual([
      {
        id: hair.body.id,
        name: 'Włosy',
        completed: 1,
        noShow: 1,
        revenueGrosze: 8000,
        paid: 1,
        cancelledByClient: 0,
        cancelledBySalon: 1,
      },
      {
        id: null,
        name: null,
        completed: 2,
        noShow: 0,
        revenueGrosze: 5000,
        paid: 1,
        cancelledByClient: 0,
        cancelledBySalon: 0,
      },
    ]);

    // A specialist with own results sees only own visits by category.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.categories).toEqual([
      expect.objectContaining({ id: hair.body.id, completed: 1, noShow: 1, revenueGrosze: 8000 }),
    ]);
  });

  it('"Usługi bez wizyt": bookable services nobody booked, in price-list order (task 259)', async () => {
    const d1 = addDays(today, -3);
    // Nothing booked yet: the whole price list, in its order.
    const empty = await report().expect(200);
    expect(empty.body.unbookedServices).toEqual([
      { id: haircutId, name: 'Strzyżenie', categoryName: null, priceGrosze: 8000 },
      { id: beardId, name: 'Broda', categoryName: null, priceGrosze: 5000 },
    ]);

    // A grouped service comes first, as on the booking page.
    const beard = await ctx
      .http()
      .post(`${base}/service-categories`)
      .set(owner.auth)
      .send({ name: 'Broda i wąsy' })
      .expect(201);
    await ctx
      .http()
      .patch(`${base}/services/${beardId}`)
      .set(owner.auth)
      .send({ version: 1, categoryId: beard.body.id })
      .expect(200);
    // A hidden service is not offered, so it is not listed.
    const hidden = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Ukryta', durationMinutes: 30, priceGrosze: 1000 })
      .expect(201);
    await ctx.prisma.service.update({ where: { id: hidden.body.id }, data: { active: false } });

    await visit({ date: d1, status: 'completed', paid: true });
    // A cancelled visit is not a booking that stayed.
    await visit({ date: d1, serviceId: beardId, status: 'cancelled' });
    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.unbookedServices).toEqual([
      { id: beardId, name: 'Broda', categoryName: 'Broda i wąsy', priceGrosze: 5000 },
    ]);

    // A no-show still means a client booked it.
    await visit({ date: d1, serviceId: beardId, status: 'no_show' });
    expect((await report().expect(200)).body.unbookedServices).toEqual([]);

    // A period that ended before the services were added lists nothing.
    const past = await report(owner.auth, {
      from: addDays(today, -30),
      to: addDays(today, -20),
    }).expect(200);
    expect(past.body.unbookedServices).toEqual([]);

    // Not in a specialist's own report.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth, { from: addDays(today, -30), to: today }).expect(200);
    expect(own.body.unbookedServices).toEqual([]);
  });

  it('"Z jakim wyprzedzeniem rezerwują": days between booking and visit, by bucket (task 260)', async () => {
    const d1 = addDays(today, -3);
    const booked = async (daysBefore: number | null, o: Partial<VisitOptions> = {}) => {
      const id = await visit({ date: d1, status: 'completed', ...o });
      if (daysBefore !== null) {
        const { startAt } = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });
        await ctx.prisma.appointment.update({
          where: { id },
          data: { createdAt: new Date(startAt.getTime() - daysBefore * 86_400_000 - 3_600_000) },
        });
      }
    };
    await booked(0, { online: true });
    await booked(1);
    await booked(5, { online: true });
    await booked(5, { status: 'no_show' });
    await booked(10);
    await booked(30, { online: true });
    // Not counted: cancelled, and written down after the visit (createdAt is now).
    await booked(3, { status: 'cancelled' });
    await booked(null);

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.leadTime).toEqual({
      visits: 6,
      medianDays: 5,
      buckets: [
        { key: 'sameDay', visits: 1, online: 1 },
        { key: 'nextDay', visits: 1, online: 0 },
        { key: 'week', visits: 2, online: 1 },
        { key: 'twoWeeks', visits: 1, online: 0 },
        { key: 'later', visits: 1, online: 1 },
      ],
    });

    // Booked at 23:30 for 00:30 the next day is "next day" in the salon's dates.
    const late = leadTime(
      [
        {
          status: 'confirmed',
          source: 'online',
          createdAt: new Date('2026-03-09T22:30:00Z'),
          startAt: new Date('2026-03-09T23:30:00Z'),
        },
      ],
      TZ,
    );
    expect(late).toMatchObject({ visits: 1, medianDays: 1 });
    expect(late.buckets[1]).toEqual({ key: 'nextDay', visits: 1, online: 1 });
    expect(leadTime([], TZ)).toMatchObject({ visits: 0, medianDays: null });
  });

  it('"Kiedy klienci odwołują": hours between the cancellation and the visit, by bucket (task 294)', async () => {
    const d1 = addDays(today, -3);
    const cancelled = async (hoursBefore: number | null, o: Partial<VisitOptions> = {}) => {
      const id = await visit({ date: d1, status: 'cancelled', ...o });
      const { startAt } = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });
      await ctx.prisma.appointment.update({
        where: { id },
        data: {
          cancelledAt:
            hoursBefore === null ? null : new Date(startAt.getTime() - hoursBefore * 3_600_000),
        },
      });
    };
    await cancelled(1);
    await cancelled(-1); // after the start: the last moment too
    await cancelled(5);
    await cancelled(30, { staffId: olaId });
    await cancelled(100);
    // Not counted: cancelled by the salon, without a cancellation time, and visits that took place.
    await cancelled(1, { cancelledBy: 'salon' });
    await cancelled(null);
    await visit({ date: d1, status: 'completed' });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.cancelNotice).toEqual({
      cancelled: 5,
      buckets: [
        { key: 'twoHours', cancelled: 2 },
        { key: 'day', cancelled: 1 },
        { key: 'threeDays', cancelled: 1 },
        { key: 'later', cancelled: 1 },
      ],
    });

    // Kasia's own report: only her visits (Ola's cancellation 30 hours before is not there).
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.cancelNotice.cancelled).toBe(4);
    expect(own.body.cancelNotice.buckets[2]).toEqual({ key: 'threeDays', cancelled: 0 });

    expect(cancelNotice([])).toEqual({
      cancelled: 0,
      buckets: [
        { key: 'twoHours', cancelled: 0 },
        { key: 'day', cancelled: 0 },
        { key: 'threeDays', cancelled: 0 },
        { key: 'later', cancelled: 0 },
      ],
    });
  });

  it('"Rabaty": coupons, tier discounts and happy hours on the paid visits (task 304)', async () => {
    const d1 = addDays(today, -3);
    const discounted = async (
      data: { discountGrosze?: number; tierDiscountGrosze?: number; listPriceGrosze?: number },
      o: Partial<VisitOptions> = {},
    ) => {
      const id = await visit({ date: d1, status: 'completed', paid: true, ...o });
      await ctx.prisma.appointment.update({
        where: { id },
        data: {
          ...data,
          ...(data.tierDiscountGrosze ? { tierName: 'Gold', tierDiscountPercent: 5 } : {}),
          ...(data.listPriceGrosze ? { happyHourPercent: 10 } : {}),
        },
      });
    };
    // A coupon of 10 zł; a tier discount of 5 zł; a coupon of 3 zł and the tier's 2 zł on one visit.
    await discounted({ discountGrosze: 1000 });
    await discounted({ discountGrosze: 500, tierDiscountGrosze: 500 });
    await discounted({ discountGrosze: 500, tierDiscountGrosze: 200 });
    // Happy hours: the price before them was 20 zł more than the visit price (Ola's visit).
    const { priceGrosze } = await ctx.prisma.service.findUniqueOrThrow({
      where: { id: haircutId },
    });
    await discounted({ listPriceGrosze: priceGrosze + 2000 }, { staffId: olaId });
    // Not counted: a visit not marked paid, a no-show and a visit without any discount.
    await discounted({ discountGrosze: 700 }, { paid: false });
    await discounted({ discountGrosze: 700 }, { status: 'no_show', paid: false });
    await visit({ date: d1, status: 'completed', paid: true });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.discounts).toEqual({
      totalGrosze: 4000,
      visits: 4,
      kinds: [
        { key: 'coupon', visits: 2, grosze: 1300 },
        { key: 'tier', visits: 2, grosze: 700 },
        { key: 'happyHours', visits: 1, grosze: 2000 },
      ],
    });
    // The revenue is already after the coupons and the tier (task 14).
    expect(res.body.totals.discountGrosze).toBe(2000);

    // Kasia's own report: only her visits (Ola's happy hour is not there).
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.discounts.totalGrosze).toBe(2000);
    expect(own.body.discounts.kinds[2]).toEqual({ key: 'happyHours', visits: 0, grosze: 0 });

    expect(discounts([])).toEqual({
      totalGrosze: 0,
      visits: 0,
      kinds: [
        { key: 'coupon', visits: 0, grosze: 0 },
        { key: 'tier', visits: 0, grosze: 0 },
        { key: 'happyHours', visits: 0, grosze: 0 },
      ],
    });
  });

  it('"Napiwki": tips of the visits that took place, by specialist, not in the revenue (task 229)', async () => {
    const d1 = addDays(today, -3);
    await visit({ date: d1, status: 'completed', paid: true, tipGrosze: 1000 });
    await visit({ date: d1, status: 'completed', tipGrosze: 500 });
    await visit({ date: d1, staffId: olaId, status: 'completed', paid: true, tipGrosze: 2000 });
    await visit({ date: d1, staffId: olaId, status: 'completed', paid: true });
    // A tip on a visit that did not take place does not count (the API refuses it anyway).
    await visit({ date: d1, status: 'no_show', tipGrosze: 700 });
    const res = await report().expect(200);
    expect(res.body.tips).toEqual({
      totalGrosze: 3500,
      visits: 3,
      staff: [
        { id: olaId, displayName: 'Ola', tipsGrosze: 2000, visits: 1 },
        { id: kasiaId, displayName: 'Kasia', tipsGrosze: 1500, visits: 2 },
      ],
    });
    // Revenue is what the visits cost, without tips.
    expect(res.body.totals.revenueGrosze).toBe(3 * 8000);

    // A specialist with own results sees only own tips.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.tips).toEqual({
      totalGrosze: 1500,
      visits: 2,
      staff: [{ id: kasiaId, displayName: 'Kasia', tipsGrosze: 1500, visits: 2 }],
    });
  });

  it('"Prowizje": owners set each specialist\'s commission, the report counts it (task 373)', async () => {
    const commissions = `${base}/reports/commissions`;
    const listed = await ctx.http().get(commissions).set(owner.auth).expect(200);
    expect(
      registeredResponseSchema('StaffCommissions').safeParse(listed.body).error,
    ).toBeUndefined();
    expect(listed.body.staff).toEqual([
      { staffId: kasiaId, displayName: 'Kasia', active: true, commissionPercent: null },
      { staffId: olaId, displayName: 'Ola', active: true, commissionPercent: null },
    ]);

    const set = await ctx
      .http()
      .put(`${commissions}/${kasiaId}`)
      .set(owner.auth)
      .send({ commissionPercent: 45.5 })
      .expect(200);
    expect(set.body.staff[0]).toMatchObject({ staffId: kasiaId, commissionPercent: 45.5 });
    await ctx
      .http()
      .put(`${commissions}/${olaId}`)
      .set(owner.auth)
      .send({ commissionPercent: 40 })
      .expect(200);
    // Two decimal places, more than 100 or below 0 are refused; so is an unknown specialist.
    for (const commissionPercent of [45.55, 101, -1, '40']) {
      await ctx
        .http()
        .put(`${commissions}/${olaId}`)
        .set(owner.auth)
        .send({ commissionPercent })
        .expect(400);
    }
    await ctx
      .http()
      .put(`${commissions}/00000000-0000-4000-8000-000000000000`)
      .set(owner.auth)
      .send({ commissionPercent: 10 })
      .expect(404);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'staff.commission_set' } })).toBe(2);

    const d1 = addDays(today, -3);
    // Kasia: 8000 + (8000 − 1000 discount) paid, a tip that is not part of it, one unpaid.
    await visit({ date: d1, status: 'completed', paid: true, tipGrosze: 2000 });
    await visit({ date: d1, status: 'completed', paid: true, discountGrosze: 1000 });
    await visit({ date: d1, status: 'completed' });
    await visit({ date: d1, staffId: olaId, serviceId: beardId, status: 'completed', paid: true });
    const res = await report().expect(200);
    expect(
      res.body.staff.map((s: Record<string, unknown>) => [
        s.id,
        s.revenueGrosze,
        s.commissionPercent,
        s.commissionGrosze,
      ]),
    ).toEqual([
      [kasiaId, 15000, 45.5, 6825],
      [olaId, 5000, 40, 2000],
    ]);

    // Removing it leaves the report without a commission.
    await ctx
      .http()
      .put(`${commissions}/${olaId}`)
      .set(owner.auth)
      .send({ commissionPercent: null })
      .expect(200);
    const after = await report().expect(200);
    expect(after.body.staff[1]).toMatchObject({ commissionPercent: null, commissionGrosze: null });

    // A specialist neither sees nor sets commissions — not even their own…
    await ctx.http().get(commissions).set(kasiaUser.auth).expect(403);
    await ctx
      .http()
      .put(`${commissions}/${kasiaId}`)
      .set(kasiaUser.auth)
      .send({ commissionPercent: 100 })
      .expect(403);
    // …but with own results the report shows their own.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.staff).toEqual([
      expect.objectContaining({ id: kasiaId, commissionPercent: 45.5, commissionGrosze: 6825 }),
    ]);

    // Another salon's owner cannot reach them.
    const other = await signUp(ctx, 'other@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await ctx.http().get(commissions).set(other.auth).expect(404);
  });

  it('"CSV wypłat": commission, tips and the total by specialist, owners only (task 391)', async () => {
    await ctx.prisma.staffMember.update({
      where: { id: kasiaId },
      data: { commissionPermille: 455 },
    });
    const d1 = addDays(today, -3);
    await visit({ date: d1, status: 'completed', paid: true, tipGrosze: 1000 });
    await visit({ date: d1, status: 'completed', paid: true, discountGrosze: 1000 });
    await visit({
      date: d1,
      staffId: olaId,
      serviceId: beardId,
      status: 'completed',
      paid: true,
      tipGrosze: 250,
    });
    await visit({ date: d1, staffId: olaId, status: 'no_show' });
    const csv = (q: object = {}, auth = owner.auth) =>
      ctx
        .http()
        .get(`${base}/reports/payout-csv`)
        .query({ from, to: today, ...q })
        .set(auth)
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => done(null, text));
        });
    const res = await csv().expect(200);
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="payout-.+-${from}-${today}\\.csv"$`),
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    // Kasia: 80 + 70 = 150 zł × 45,5% = 68,25 zł, plus a 10 zł tip. Ola: no commission set.
    expect(text.slice(1).trimEnd().split('\r\n')).toEqual([
      'Specjalista;Odbyte wizyty;Opłacone wizyty;Przychód;Prowizja %;Prowizja;Napiwki;Do wypłaty',
      'Kasia;2;2;150,00;45,5;68,25;10,00;78,25',
      'Ola;1;1;50,00;;;2,50;2,50',
      'Razem;3;3;200,00;;68,25;12,50;80,75',
    ]);
    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain('Kasia;2;2;150.00;45.5;68.25;10.00;78.25');

    // A specialist cannot download it, even with own results.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    await csv({}, kasiaUser.auth).expect(403);
    await csv({ from: today, to: from }).expect(400);
  });

  it('"Produkty": the salon\'s products, sold at a visit, counted apart in the report (task 394)', async () => {
    const product = async (name: string, priceGrosze: number) =>
      (
        await ctx
          .http()
          .post(`${base}/products`)
          .set(owner.auth)
          .send({ name, priceGrosze })
          .expect(201)
      ).body as { id: string; name: string; priceGrosze: number; active: boolean };
    const pomade = await product('Pomada', 4500);
    const shampoo = await product('Szampon', 3000);
    expect(registeredResponseSchema('Product').safeParse(pomade).error).toBeUndefined();
    // Only owners and managers change the list; everyone in the salon reads it.
    await ctx
      .http()
      .post(`${base}/products`)
      .set(kasiaUser.auth)
      .send({ name: 'Wosk', priceGrosze: 100 })
      .expect(403);
    const listed = await ctx.http().get(`${base}/products`).set(kasiaUser.auth).expect(200);
    expect(listed.body.products.map((p: { name: string }) => p.name)).toEqual([
      'Pomada',
      'Szampon',
    ]);

    const d1 = addDays(today, -3);
    const kasiaVisit = await visit({ date: d1, status: 'completed', paid: true });
    const olaVisit = await visit({ date: d1, staffId: olaId, status: 'completed', paid: true });
    const upcoming = await visit({ date: addDays(today, 1), status: 'confirmed' });
    const sales = (id: string) => `${base}/appointments/${id}/products`;

    // Only at a visit that took place.
    await ctx
      .http()
      .post(sales(upcoming))
      .set(owner.auth)
      .send({ productId: pomade.id })
      .expect(409);
    const first = await ctx
      .http()
      .post(sales(kasiaVisit))
      .set(owner.auth)
      .send({ productId: pomade.id, quantity: 2 })
      .expect(201);
    expect(
      registeredResponseSchema('VisitProductSales').safeParse(first.body).error,
    ).toBeUndefined();
    expect(first.body.totalGrosze).toBe(9000);
    // Kasia notes a sale at her own visit; Ola's visit is not hers to see.
    await ctx
      .http()
      .post(sales(kasiaVisit))
      .set(kasiaUser.auth)
      .send({ productId: shampoo.id })
      .expect(201);
    await ctx
      .http()
      .post(sales(olaVisit))
      .set(kasiaUser.auth)
      .send({ productId: shampoo.id })
      .expect(404);
    const olaSale = await ctx
      .http()
      .post(sales(olaVisit))
      .set(owner.auth)
      .send({ productId: shampoo.id })
      .expect(201);
    // A wrong quantity or another salon's product id is refused.
    await ctx
      .http()
      .post(sales(olaVisit))
      .set(owner.auth)
      .send({ productId: shampoo.id, quantity: 0 })
      .expect(400);
    await ctx
      .http()
      .post(sales(olaVisit))
      .set(owner.auth)
      .send({ productId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);

    // The price changes later: the sales keep the old price; a removed product keeps its sales.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ priceGrosze: 5000 })
      .expect(200);
    await ctx.http().delete(`${base}/products/${shampoo.id}`).set(owner.auth).expect(204);
    const kept = await ctx.http().get(sales(kasiaVisit)).set(owner.auth).expect(200);
    expect(kept.body).toEqual({
      sales: [
        expect.objectContaining({
          productId: pomade.id,
          name: 'Pomada',
          quantity: 2,
          unitPriceGrosze: 4500,
          totalGrosze: 9000,
        }),
        expect.objectContaining({
          productId: null,
          name: 'Szampon',
          quantity: 1,
          totalGrosze: 3000,
        }),
      ],
      totalGrosze: 12000,
    });
    // A removed product cannot be sold any more.
    await ctx
      .http()
      .post(sales(olaVisit))
      .set(owner.auth)
      .send({ productId: shampoo.id })
      .expect(404);

    const res = await report().expect(200);
    expect(res.body.products).toEqual({
      totalGrosze: 15000,
      quantity: 4,
      items: [
        { name: 'Pomada', quantity: 2, totalGrosze: 9000, marginGrosze: null },
        { name: 'Szampon', quantity: 2, totalGrosze: 6000, marginGrosze: null },
      ],
      staff: [
        { id: kasiaId, displayName: 'Kasia', quantity: 3, totalGrosze: 12000 },
        { id: olaId, displayName: 'Ola', quantity: 1, totalGrosze: 3000 },
      ],
      margin: null,
      // Task 471: no supplier written, and the shampoo is removed — one line without a supplier.
      suppliers: [{ supplier: null, quantity: 4, totalGrosze: 15000, marginGrosze: null }],
    });
    // Not part of the visit revenue.
    expect(res.body.totals.revenueGrosze).toBe(2 * 8000);

    // Removing a sale noted by mistake.
    const removed = await ctx
      .http()
      .delete(`${sales(olaVisit)}/${olaSale.body.sales[0].id}`)
      .set(owner.auth)
      .expect(200);
    expect(removed.body).toEqual({ sales: [], totalGrosze: 0 });

    // A specialist with own results sees only the products of her own visits.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.products).toMatchObject({ totalGrosze: 12000, quantity: 3 });

    // Another salon reaches nothing.
    const other = await signUp(ctx, 'other@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await ctx.http().get(`${base}/products`).set(other.auth).expect(404);
  });

  it('"Stan magazynowy": a sale takes pieces from stock, removing it puts them back (task 429)', async () => {
    const pomade = (
      await ctx
        .http()
        .post(`${base}/products`)
        .set(owner.auth)
        .send({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 3 })
        .expect(201)
    ).body as { id: string; stockQuantity: number | null };
    expect(pomade.stockQuantity).toBe(3);
    expect(registeredResponseSchema('Product').safeParse(pomade).error).toBeUndefined();
    // Without a number the salon does not count the pieces.
    const wax = (
      await ctx
        .http()
        .post(`${base}/products`)
        .set(owner.auth)
        .send({ name: 'Wosk', priceGrosze: 3000 })
        .expect(201)
    ).body as { id: string; stockQuantity: number | null };
    expect(wax.stockQuantity).toBeNull();
    // A negative number is refused; only owners and managers change it.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ stockQuantity: -1 })
      .expect(400);
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(kasiaUser.auth)
      .send({ stockQuantity: 10 })
      .expect(403);

    const stock = async (id: string) =>
      (
        (await ctx.http().get(`${base}/products`).set(kasiaUser.auth).expect(200)).body as {
          products: { id: string; stockQuantity: number | null }[];
        }
      ).products.find((p) => p.id === id)?.stockQuantity;
    const kasiaVisit = await visit({ date: addDays(today, -1), status: 'completed', paid: true });
    const sales = `${base}/appointments/${kasiaVisit}/products`;

    const sold = await ctx
      .http()
      .post(sales)
      .set(kasiaUser.auth)
      .send({ productId: pomade.id, quantity: 2 })
      .expect(201);
    expect(await stock(pomade.id)).toBe(1);
    // More than there is: refused, nothing changes.
    const tooMany = await ctx
      .http()
      .post(sales)
      .set(owner.auth)
      .send({ productId: pomade.id, quantity: 2 })
      .expect(409);
    expectError(tooMany.body, 'OUT_OF_STOCK');
    expect(await stock(pomade.id)).toBe(1);
    expect((await ctx.http().get(sales).set(owner.auth).expect(200)).body.sales).toHaveLength(1);
    // A product without a count is sold as before.
    await ctx
      .http()
      .post(sales)
      .set(owner.auth)
      .send({ productId: wax.id, quantity: 5 })
      .expect(201);
    expect(await stock(wax.id)).toBeNull();

    // Removing the sale noted by mistake puts the pieces back.
    await ctx.http().delete(`${sales}/${sold.body.sales[0].id}`).set(owner.auth).expect(200);
    expect(await stock(pomade.id)).toBe(3);
    // The owner corrects the count after a delivery, or stops counting.
    const updated = await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ stockQuantity: 12 })
      .expect(200);
    expect(updated.body.stockQuantity).toBe(12);
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ stockQuantity: null })
      .expect(200);
    expect(await stock(pomade.id)).toBeNull();
  });

  it('"Cena zakupu": only owners and managers see it; a sale keeps it for the "Marża" (tasks 448-449)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
        purchasePriceGrosze: number | null;
      };
    const pomade = await add({ name: 'Pomada', priceGrosze: 4500, purchasePriceGrosze: 2000 });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000 });
    expect(pomade.purchasePriceGrosze).toBe(2000);
    expect(wax.purchasePriceGrosze).toBeNull();
    expect(registeredResponseSchema('Product').safeParse(pomade).error).toBeUndefined();
    await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Żel', priceGrosze: 100, purchasePriceGrosze: -1 })
      .expect(400);
    // A specialist reads the list but never what the salon pays.
    const listed = async (auth: { Authorization: string }) =>
      (
        (await ctx.http().get(`${base}/products`).set(auth).expect(200)).body as {
          products: { id: string; purchasePriceGrosze: number | null }[];
        }
      ).products;
    expect((await listed(owner.auth)).find((p) => p.id === pomade.id)?.purchasePriceGrosze).toBe(
      2000,
    );
    expect((await listed(kasiaUser.auth)).every((p) => p.purchasePriceGrosze === null)).toBe(true);
    await ctx
      .http()
      .patch(`${base}/products/${wax.id}`)
      .set(kasiaUser.auth)
      .send({ purchasePriceGrosze: 100 })
      .expect(403);

    const kasiaVisit = await visit({ date: addDays(today, -1), status: 'completed', paid: true });
    const sales = `${base}/appointments/${kasiaVisit}/products`;
    const sell = (productId: string, quantity: number) =>
      ctx.http().post(sales).set(kasiaUser.auth).send({ productId, quantity }).expect(201);
    await sell(pomade.id, 2);
    await sell(wax.id, 1);
    // A later price does not change what was sold before: the sale keeps the price of its moment.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ purchasePriceGrosze: 2500 })
      .expect(200);
    await ctx
      .http()
      .patch(`${base}/products/${wax.id}`)
      .set(owner.auth)
      .send({ purchasePriceGrosze: 1000 })
      .expect(200);
    await sell(wax.id, 1);

    const res = await report().expect(200);
    expect(res.body.products.items).toEqual([
      { name: 'Pomada', quantity: 2, totalGrosze: 9000, marginGrosze: 5000 },
      { name: 'Wosk', quantity: 2, totalGrosze: 6000, marginGrosze: 2000 },
    ]);
    expect(res.body.products.margin).toEqual({
      quantity: 3,
      salesGrosze: 12000,
      costGrosze: 5000,
      marginGrosze: 7000,
    });
    // A specialist's own report: her sales, but not the salon's purchase prices.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = await report(kasiaUser.auth).expect(200);
    expect(own.body.products.totalGrosze).toBe(15000);
    expect(own.body.products.margin).toBeNull();
    expect(
      own.body.products.items.every(
        (i: { marginGrosze: number | null }) => i.marginGrosze === null,
      ),
    ).toBe(true);
    // Task 471: the sales by today's supplier; the products without one last, even with more money.
    expect(own.body.products.suppliers).toEqual([]);
    await ctx
      .http()
      .patch(`${base}/products/${wax.id}`)
      .set(owner.auth)
      .send({ supplier: 'Barber' })
      .expect(200);
    const bySupplier = await report().expect(200);
    expect(bySupplier.body.products.suppliers).toEqual([
      { supplier: 'Barber', quantity: 2, totalGrosze: 6000, marginGrosze: 2000 },
      { supplier: null, quantity: 2, totalGrosze: 9000, marginGrosze: 5000 },
    ]);
    // The same supplier in another letter case is one line.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ supplier: 'BARBER' })
      .expect(200);
    const merged = (await report().expect(200)).body.products.suppliers as {
      supplier: string;
      quantity: number;
      totalGrosze: number;
      marginGrosze: number | null;
    }[];
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ quantity: 4, totalGrosze: 15000, marginGrosze: 7000 });
    expect(merged[0]?.supplier.toLowerCase()).toBe('barber');
    // Writing the price down again: the owner can also clear it.
    const cleared = await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ purchasePriceGrosze: null })
      .expect(200);
    expect(cleared.body.purchasePriceGrosze).toBeNull();
  });

  it('"Dostawa": the pieces that arrived are added to the stock (task 438)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({
      name: 'Pomada',
      priceGrosze: 4500,
      stockQuantity: 2,
      lowStockAt: 3,
    });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000 });
    const restock = (id: string, quantity: unknown, auth = owner.auth) =>
      ctx.http().post(`${base}/products/${id}/restock`).set(auth).send({ quantity });

    const res = await restock(pomade.id, 10).expect(200);
    expect(res.body).toMatchObject({ stockQuantity: 12, lowStock: false });
    expect(registeredResponseSchema('Product').safeParse(res.body).error).toBeUndefined();
    // A product that did not count its pieces starts counting with the delivery.
    expect((await restock(wax.id, 4).expect(200)).body).toMatchObject({ stockQuantity: 4 });

    // Nothing, a negative or a broken number is refused; too many in stock too.
    await restock(pomade.id, 0).expect(400);
    await restock(pomade.id, -2).expect(400);
    await restock(pomade.id, 'pięć').expect(400);
    expectError((await restock(pomade.id, 99_990).expect(409)).body, 'STOCK_LIMIT');
    await restock(pomade.id, 99_988).expect(200);

    // Only owners and managers; another salon's or a missing product is not found.
    await restock(wax.id, 1, kasiaUser.auth).expect(403);
    await restock('00000000-0000-4000-8000-000000000000', 1).expect(404);
    const other = await signUp(ctx, 'other-restock@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await restock(wax.id, 1, other.auth).expect(404);
    const list = (await ctx.http().get(`${base}/products`).set(owner.auth).expect(200)).body as {
      products: { id: string; stockQuantity: number | null }[];
    };
    expect(list.products.find((p) => p.id === wax.id)?.stockQuantity).toBe(4);
    expect(list.products.find((p) => p.id === pomade.id)?.stockQuantity).toBe(100_000);
  });

  it('"Odpis": pieces used in the salon or damaged leave the stock with a note (task 443)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({
      name: 'Pomada',
      priceGrosze: 4500,
      stockQuantity: 5,
      lowStockAt: 3,
    });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000 });
    const writeOff = (id: string, body: object, auth = owner.auth) =>
      ctx.http().post(`${base}/products/${id}/write-off`).set(auth).send(body);

    const res = await writeOff(pomade.id, { quantity: 2, note: '  zużyte w salonie ' }).expect(200);
    expect(res.body).toMatchObject({ stockQuantity: 3, lowStock: true });
    expect(registeredResponseSchema('Product').safeParse(res.body).error).toBeUndefined();
    await writeOff(pomade.id, { quantity: 1 }).expect(200);

    // Nothing, a negative or a broken number is refused; more than in stock too.
    await writeOff(pomade.id, { quantity: 0 }).expect(400);
    await writeOff(pomade.id, { quantity: -1 }).expect(400);
    await writeOff(pomade.id, { quantity: 1, note: 'x'.repeat(121) }).expect(400);
    expectError((await writeOff(pomade.id, { quantity: 3 }).expect(409)).body, 'OUT_OF_STOCK');
    // A product whose pieces are not counted has nothing to write off.
    expectError((await writeOff(wax.id, { quantity: 1 }).expect(409)).body, 'NOT_COUNTED');

    // Only owners and managers; another salon's or a missing product is not found.
    await writeOff(pomade.id, { quantity: 1 }, kasiaUser.auth).expect(403);
    await writeOff('00000000-0000-4000-8000-000000000000', { quantity: 1 }).expect(404);
    const other = await signUp(ctx, 'other-write-off@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await writeOff(pomade.id, { quantity: 1 }, other.auth).expect(404);

    // "Historia magazynu" shows each write-off with its note.
    const history = await ctx
      .http()
      .get(`${base}/products/${pomade.id}/stock-history`)
      .set(owner.auth)
      .expect(200);
    expect(registeredResponseSchema('StockHistory').safeParse(history.body).error).toBeUndefined();
    expect(
      (
        history.body as {
          movements: { kind: string; change: number; quantityAfter: number; note: string | null }[];
        }
      ).movements.map(({ kind, change, quantityAfter, note }) => ({
        kind,
        change,
        quantityAfter,
        note,
      })),
    ).toEqual([
      { kind: 'write_off', change: -1, quantityAfter: 2, note: null },
      { kind: 'write_off', change: -2, quantityAfter: 3, note: 'zużyte w salonie' },
      { kind: 'correction', change: 5, quantityAfter: 5, note: null },
    ]);
  });

  it('"Inwentaryzacja": the pieces counted on the shelf, for many products at once (task 456)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 5 });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000 });
    const gel = await add({ name: 'Żel', priceGrosze: 2500, stockQuantity: 2 });
    const count = (counts: unknown, auth = owner.auth) =>
      ctx.http().post(`${base}/products/stocktake`).set(auth).send({ counts });

    const res = await count([
      { productId: pomade.id, quantity: 3 },
      { productId: wax.id, quantity: 4 },
      { productId: gel.id, quantity: 2 },
    ]).expect(200);
    expect(registeredResponseSchema('Stocktake').safeParse(res.body).error).toBeUndefined();
    // Two products changed; 2 pomades are missing (wax was not counted before, so not "extra").
    expect(res.body).toMatchObject({ changed: 2, missingPieces: 2, extraPieces: 0 });
    const stock = (body: { products: { id: string; stockQuantity: number | null }[] }) =>
      Object.fromEntries(body.products.map((p) => [p.id, p.stockQuantity]));
    expect(stock(res.body)).toMatchObject({ [pomade.id]: 3, [wax.id]: 4, [gel.id]: 2 });
    expect((await count([{ productId: pomade.id, quantity: 6 }]).expect(200)).body).toMatchObject({
      changed: 1,
      missingPieces: 0,
      extraPieces: 3,
    });

    // Nothing, a negative number, the same product twice or too many pieces are refused.
    await count([]).expect(400);
    await count([{ productId: pomade.id, quantity: -1 }]).expect(400);
    await count([{ productId: pomade.id, quantity: 100_001 }]).expect(400);
    await count([
      { productId: pomade.id, quantity: 1 },
      { productId: pomade.id, quantity: 2 },
    ]).expect(400);

    // Only owners and managers; another salon's or a missing product: 404 and nothing changes.
    await count([{ productId: pomade.id, quantity: 1 }], kasiaUser.auth).expect(403);
    await count([
      { productId: pomade.id, quantity: 1 },
      { productId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
    ]).expect(404);
    const other = await signUp(ctx, 'other-stocktake@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await count([{ productId: pomade.id, quantity: 1 }], other.auth).expect(404);
    const list = (await ctx.http().get(`${base}/products`).set(owner.auth).expect(200)).body as {
      products: { id: string; stockQuantity: number | null }[];
    };
    expect(stock(list)[pomade.id]).toBe(6);
    // Wax only started counting: a number written by hand, not a stocktake difference.
    const waxHistory = await ctx
      .http()
      .get(`${base}/products/${wax.id}/stock-history`)
      .set(owner.auth)
      .expect(200);
    expect(
      (waxHistory.body as { movements: { kind: string; change: number }[] }).movements.map(
        ({ kind, change }) => ({ kind, change }),
      ),
    ).toEqual([{ kind: 'correction', change: 4 }]);

    // "Historia magazynu" shows each counted difference.
    const history = await ctx
      .http()
      .get(`${base}/products/${pomade.id}/stock-history`)
      .set(owner.auth)
      .expect(200);
    expect(registeredResponseSchema('StockHistory').safeParse(history.body).error).toBeUndefined();
    expect(
      (
        history.body as { movements: { kind: string; change: number; quantityAfter: number }[] }
      ).movements.map(({ kind, change, quantityAfter }) => ({ kind, change, quantityAfter })),
    ).toEqual([
      { kind: 'stocktake', change: 3, quantityAfter: 6 },
      { kind: 'stocktake', change: -2, quantityAfter: 3 },
      { kind: 'correction', change: 5, quantityAfter: 5 },
    ]);
  });

  it('"Odpisy z magazynu": pieces written off in the period, at today\'s prices (task 446)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 6 });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000, stockQuantity: 9 });
    const writeOff = (id: string, quantity: number) =>
      ctx
        .http()
        .post(`${base}/products/${id}/write-off`)
        .set(owner.auth)
        .send({ quantity })
        .expect(200);
    expect((await report().expect(200)).body.writeOffs).toEqual({
      quantity: 0,
      valueGrosze: 0,
      items: [],
    });
    await writeOff(pomade.id, 1);
    await writeOff(pomade.id, 1);
    await writeOff(wax.id, 3);
    // A sale or a delivery is not a write-off.
    await ctx
      .http()
      .post(`${base}/products/${wax.id}/restock`)
      .set(owner.auth)
      .send({ quantity: 2 })
      .expect(200);
    // An older write-off is outside the period.
    await writeOff(wax.id, 1);
    await ctx.prisma.stockMovement.updateMany({
      where: { productId: wax.id, kind: 'write_off', change: -1 },
      data: { createdAt: new Date(`${addDays(from, -3)}T12:00:00Z`) },
    });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error).toBeUndefined();
    expect(res.body.writeOffs).toEqual({
      quantity: 5,
      valueGrosze: 2 * 4500 + 3 * 3000,
      items: [
        { name: 'Wosk', quantity: 3, valueGrosze: 9000 },
        { name: 'Pomada', quantity: 2, valueGrosze: 9000 },
      ],
    });
    // A specialist's own report has no salon stock in it.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    expect((await report(kasiaUser.auth).expect(200)).body.writeOffs).toEqual({
      quantity: 0,
      valueGrosze: 0,
      items: [],
    });
  });

  it('"Dostawy na magazyn": pieces delivered in the period, at today\'s purchase prices (task 452)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({
      name: 'Pomada',
      priceGrosze: 4500,
      purchasePriceGrosze: 2000,
      supplier: 'Hairgum',
    });
    // Task 467: the same supplier in another letter case.
    const clay = await add({
      name: 'Glinka',
      priceGrosze: 5000,
      purchasePriceGrosze: 1000,
      supplier: 'hairgum',
    });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000, stockQuantity: 1 });
    const restock = (id: string, quantity: number) =>
      ctx
        .http()
        .post(`${base}/products/${id}/restock`)
        .set(owner.auth)
        .send({ quantity })
        .expect(200);
    expect((await report().expect(200)).body.deliveries).toEqual({
      quantity: 0,
      costGrosze: null,
      items: [],
      suppliers: [],
    });
    // Without a purchase price the pieces count, the money does not.
    await restock(wax.id, 3);
    expect((await report().expect(200)).body.deliveries).toEqual({
      quantity: 3,
      costGrosze: null,
      items: [{ name: 'Wosk', quantity: 3, costGrosze: null }],
      suppliers: [{ supplier: null, quantity: 3, costGrosze: null }],
    });
    await restock(pomade.id, 2);
    await restock(pomade.id, 4);
    await restock(clay.id, 1);
    // A write-off or a hand-written number is not a delivery.
    await ctx
      .http()
      .post(`${base}/products/${pomade.id}/write-off`)
      .set(owner.auth)
      .send({ quantity: 1 })
      .expect(200);
    await ctx
      .http()
      .patch(`${base}/products/${wax.id}`)
      .set(owner.auth)
      .send({ stockQuantity: 10 })
      .expect(200);
    // An older delivery is outside the period.
    await restock(wax.id, 5);
    await ctx.prisma.stockMovement.updateMany({
      where: { productId: wax.id, kind: 'delivery', change: 5 },
      data: { createdAt: new Date(`${addDays(from, -3)}T12:00:00Z`) },
    });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error).toBeUndefined();
    expect(res.body.deliveries).toEqual({
      quantity: 10,
      costGrosze: 6 * 2000 + 1000,
      items: [
        { name: 'Pomada', quantity: 6, costGrosze: 12000 },
        { name: 'Wosk', quantity: 3, costGrosze: null },
        { name: 'Glinka', quantity: 1, costGrosze: 1000 },
      ],
      // Task 467: by supplier — Hairgum in any letter case together, without a supplier last.
      suppliers: [
        { supplier: 'Hairgum', quantity: 7, costGrosze: 13000 },
        { supplier: null, quantity: 3, costGrosze: null },
      ],
    });
    // A specialist's own report has no salon stock in it.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    expect((await report(kasiaUser.auth).expect(200)).body.deliveries).toEqual({
      quantity: 0,
      costGrosze: null,
      items: [],
      suppliers: [],
    });
  });

  it('"Starczy na": pieces sold at the visits of the last 30 days, in the products list (task 461)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 6 });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000, stockQuantity: 2 });
    await add({ name: 'Żel', priceGrosze: 2500 });
    const listed = async (auth = owner.auth) =>
      (await ctx.http().get(`${base}/products`).set(auth).expect(200)).body as {
        sold30Days: { productId: string; quantity: number }[];
      };
    expect((await listed()).sold30Days).toEqual([]);

    const sell = async (date: string, productId: string, quantity: number) => {
      const id = await visit({ date, status: 'completed', paid: true });
      await ctx
        .http()
        .post(`${base}/appointments/${id}/products`)
        .set(owner.auth)
        .send({ productId, quantity })
        .expect(201);
    };
    await sell(addDays(today, -2), pomade.id, 2);
    await sell(addDays(today, -20), pomade.id, 1);
    await sell(addDays(today, -5), wax.id, 1);
    // A sale of 40 days ago is not counted.
    await sell(addDays(today, -40), wax.id, 1);

    const expected = [
      { productId: pomade.id, quantity: 3 },
      { productId: wax.id, quantity: 1 },
    ].sort((a, b) => a.productId.localeCompare(b.productId));
    const res = await ctx.http().get(`${base}/products`).set(owner.auth).expect(200);
    expect(registeredResponseSchema('ProductList').safeParse(res.body).error).toBeUndefined();
    expect(res.body.sold30Days).toEqual(expected);
    // Everyone in the salon reads the list, so a specialist sees it too.
    expect((await listed(kasiaUser.auth)).sold30Days).toEqual(expected);
  });

  it('"Różnice inwentaryzacji": pieces missing or extra at the stocktakes of the period (task 459)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 5 });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000, stockQuantity: 2 });
    const gel = await add({ name: 'Żel', priceGrosze: 2500 });
    const empty = {
      missingQuantity: 0,
      missingGrosze: 0,
      extraQuantity: 0,
      extraGrosze: 0,
      items: [],
    };
    expect((await report().expect(200)).body.stocktakes).toEqual(empty);
    const count = (counts: { productId: string; quantity: number }[]) =>
      ctx.http().post(`${base}/products/stocktake`).set(owner.auth).send({ counts }).expect(200);
    // Two pomades missing, one wax extra; the gel only starts counting (not a difference).
    await count([
      { productId: pomade.id, quantity: 3 },
      { productId: wax.id, quantity: 3 },
      { productId: gel.id, quantity: 4 },
    ]);
    // A later count of the same product adds up; a write-off is not a difference.
    await count([{ productId: pomade.id, quantity: 2 }]);
    await ctx
      .http()
      .post(`${base}/products/${wax.id}/write-off`)
      .set(owner.auth)
      .send({ quantity: 1 })
      .expect(200);
    // An older stocktake is outside the period.
    await count([{ productId: wax.id, quantity: 9 }]);
    await ctx.prisma.stockMovement.updateMany({
      where: { productId: wax.id, kind: 'stocktake', quantityAfter: 9 },
      data: { createdAt: new Date(`${addDays(from, -3)}T12:00:00Z`) },
    });

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error).toBeUndefined();
    expect(res.body.stocktakes).toEqual({
      missingQuantity: 3,
      missingGrosze: 3 * 4500,
      extraQuantity: 1,
      extraGrosze: 3000,
      items: [
        { name: 'Pomada', missing: 3, extra: 0, missingGrosze: 13500, extraGrosze: 0 },
        { name: 'Wosk', missing: 0, extra: 1, missingGrosze: 0, extraGrosze: 3000 },
      ],
    });
    // A specialist's own report has no salon stock in it.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    expect((await report(kasiaUser.auth).expect(200)).body.stocktakes).toEqual(empty);
  });

  it('"Leżą bez sprzedaży": counted products with pieces that no visit of the period sold (task 460)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 5 });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000, stockQuantity: 3 });
    await add({ name: 'Żel', priceGrosze: 2500, stockQuantity: 4 });
    // Not counted, nothing on the shelf, or no longer sold — not in the list.
    await add({ name: 'Olejek', priceGrosze: 2000 });
    await add({ name: 'Szampon', priceGrosze: 3500, stockQuantity: 0 });
    const comb = await add({ name: 'Grzebień', priceGrosze: 1500, stockQuantity: 3 });
    await ctx.prisma.product.update({ where: { id: comb.id }, data: { active: false } });

    const sell = async (date: string, productId: string) => {
      const id = await visit({ date, status: 'completed', paid: true });
      await ctx
        .http()
        .post(`${base}/appointments/${id}/products`)
        .set(owner.auth)
        .send({ productId, quantity: 1 })
        .expect(201);
    };
    // The pomade sold in the period; the wax only before it.
    await sell(addDays(today, -2), pomade.id);
    await sell(addDays(from, -3), wax.id);
    await sell(addDays(from, -20), wax.id);

    const res = await report().expect(200);
    expect(registeredResponseSchema('SalonReport').safeParse(res.body).error).toBeUndefined();
    expect(res.body.idleProducts).toEqual({
      quantity: 5,
      valueGrosze: 4 * 2500 + 3000,
      items: [
        { name: 'Żel', stock: 4, valueGrosze: 10000, lastSoldOn: null },
        { name: 'Wosk', stock: 1, valueGrosze: 3000, lastSoldOn: addDays(from, -3) },
      ],
    });
    // A specialist's own report has no salon stock in it.
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    expect((await report(kasiaUser.auth).expect(200)).body.idleProducts).toEqual({
      quantity: 0,
      valueGrosze: 0,
      items: [],
    });
  });

  it('removing a sale gives back only the pieces it took (task 622)', async () => {
    // Not counted at the sale; the salon starts counting afterwards.
    const gel = (
      await ctx
        .http()
        .post(`${base}/products`)
        .set(owner.auth)
        .send({ name: 'Żel', priceGrosze: 3000 })
        .expect(201)
    ).body as { id: string };
    const sales = `${base}/appointments/${await visit({ date: addDays(today, -1), status: 'completed', paid: true })}/products`;
    const sold = await ctx
      .http()
      .post(sales)
      .set(owner.auth)
      .send({ productId: gel.id, quantity: 2 })
      .expect(201);
    await ctx
      .http()
      .patch(`${base}/products/${gel.id}`)
      .set(owner.auth)
      .send({ stockQuantity: 10 })
      .expect(200);
    await ctx.http().delete(`${sales}/${sold.body.sales[0].id}`).set(owner.auth).expect(200);
    const after = await ctx.prisma.product.findUniqueOrThrow({ where: { id: gel.id } });
    expect(after.stockQuantity).toBe(10);
    const kinds = await ctx.prisma.stockMovement.findMany({
      where: { productId: gel.id },
      select: { kind: true },
    });
    expect(kinds.map((k) => k.kind)).toEqual(['correction']);

    // Counted at the sale: the pieces come back.
    const again = await ctx
      .http()
      .post(sales)
      .set(owner.auth)
      .send({ productId: gel.id, quantity: 3 })
      .expect(201);
    expect(
      (await ctx.prisma.product.findUniqueOrThrow({ where: { id: gel.id } })).stockQuantity,
    ).toBe(7);
    await ctx.http().delete(`${sales}/${again.body.sales[0].id}`).set(owner.auth).expect(200);
    expect(
      (await ctx.prisma.product.findUniqueOrThrow({ where: { id: gel.id } })).stockQuantity,
    ).toBe(10);
  });

  it('"Historia magazynu": every change of the stock with who and when (task 440)', async () => {
    const pomade = (
      await ctx
        .http()
        .post(`${base}/products`)
        .set(owner.auth)
        .send({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 3 })
        .expect(201)
    ).body as { id: string };
    const history = (auth = owner.auth) =>
      ctx.http().get(`${base}/products/${pomade.id}/stock-history`).set(auth);
    // A sale by Kasia, the sale removed by the owner, a delivery, a number written by hand.
    const sales = `${base}/appointments/${await visit({ date: addDays(today, -1), status: 'completed', paid: true })}/products`;
    const sold = await ctx
      .http()
      .post(sales)
      .set(kasiaUser.auth)
      .send({ productId: pomade.id, quantity: 2 })
      .expect(201);
    await ctx.http().delete(`${sales}/${sold.body.sales[0].id}`).set(owner.auth).expect(200);
    await ctx
      .http()
      .post(`${base}/products/${pomade.id}/restock`)
      .set(owner.auth)
      .send({ quantity: 5 })
      .expect(200);
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ stockQuantity: 7 })
      .expect(200);
    // Only the name or the price: no movement; not counting any more: one.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ priceGrosze: 4600, stockQuantity: 7 })
      .expect(200);
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ stockQuantity: null })
      .expect(200);

    const res = await history().expect(200);
    expect(registeredResponseSchema('StockHistory').safeParse(res.body).error).toBeUndefined();
    expect(res.body.movements[0]).toMatchObject({
      date: today,
      time: expect.stringMatching(/^\d\d:\d\d$/),
    });
    const rows = (
      res.body as {
        movements: { kind: string; change: number; quantityAfter: number | null; byName: string }[];
      }
    ).movements.map(({ kind, change, quantityAfter, byName }) => ({
      kind,
      change,
      quantityAfter,
      byName,
    }));
    const ownerName = (
      await ctx.prisma.user.findFirstOrThrow({ where: { email: 'owner@example.com' } })
    ).name;
    const kasiaName = (
      await ctx.prisma.user.findFirstOrThrow({ where: { email: 'kasia@example.com' } })
    ).name;
    expect(rows).toEqual([
      { kind: 'correction', change: -7, quantityAfter: null, byName: ownerName },
      { kind: 'correction', change: -1, quantityAfter: 7, byName: ownerName },
      { kind: 'delivery', change: 5, quantityAfter: 8, byName: ownerName },
      { kind: 'sale_removed', change: 2, quantityAfter: 3, byName: ownerName },
      { kind: 'sale', change: -2, quantityAfter: 1, byName: kasiaName },
      { kind: 'correction', change: 3, quantityAfter: 3, byName: ownerName },
    ]);

    // Only owners and managers; another salon's product is not found.
    await history(kasiaUser.auth).expect(403);
    const other = await signUp(ctx, 'other-history@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await history(other.auth).expect(404);
    await ctx
      .http()
      .get(`${base}/products/00000000-0000-4000-8000-000000000000/stock-history`)
      .set(owner.auth)
      .expect(404);
  });

  it('"Kończy się": a product warns at its own number of pieces or fewer (task 433)', async () => {
    const created = await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Pomada', priceGrosze: 4500, stockQuantity: 3, lowStockAt: 1 })
      .expect(201);
    const pomade = created.body as { id: string; lowStockAt: number | null; lowStock: boolean };
    expect(pomade).toMatchObject({ lowStockAt: 1, lowStock: false });
    expect(registeredResponseSchema('Product').safeParse(pomade).error).toBeUndefined();
    // Without numbers there is no warning.
    const wax = (
      await ctx
        .http()
        .post(`${base}/products`)
        .set(owner.auth)
        .send({ name: 'Wosk', priceGrosze: 3000, lowStockAt: 5 })
        .expect(201)
    ).body as { id: string };
    // A negative number is refused; only owners and managers change it.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ lowStockAt: -1 })
      .expect(400);
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(kasiaUser.auth)
      .send({ lowStockAt: 2 })
      .expect(403);

    const read = async (id: string) => {
      const list = (await ctx.http().get(`${base}/products`).set(kasiaUser.auth).expect(200))
        .body as {
        products: { id: string; stockQuantity: number | null; lowStock: boolean }[];
      };
      expect(registeredResponseSchema('ProductList').safeParse(list).error).toBeUndefined();
      return list.products.find((p) => p.id === id)!;
    };
    expect((await read(wax.id)).lowStock).toBe(false);

    // Two pieces sold: one left — "Kończy się"; the sale removed — no longer.
    const sales = `${base}/appointments/${await visit({ date: addDays(today, -1), status: 'completed', paid: true })}/products`;
    const sold = await ctx
      .http()
      .post(sales)
      .set(kasiaUser.auth)
      .send({ productId: pomade.id, quantity: 2 })
      .expect(201);
    expect(await read(pomade.id)).toMatchObject({ stockQuantity: 1, lowStock: true });
    await ctx.http().delete(`${sales}/${sold.body.sales[0].id}`).set(owner.auth).expect(200);
    expect(await read(pomade.id)).toMatchObject({ stockQuantity: 3, lowStock: false });

    // The owner raises the number; then turns the warning off.
    const raised = await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ lowStockAt: 3 })
      .expect(200);
    expect(raised.body).toMatchObject({ lowStockAt: 3, lowStock: true });
    const off = await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ lowStockAt: null })
      .expect(200);
    expect(off.body).toMatchObject({ lowStockAt: null, lowStock: false });
    // Not counting the pieces any more: no warning either.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ lowStockAt: 10, stockQuantity: null })
      .expect(200);
    expect((await read(pomade.id)).lowStock).toBe(false);
  });

  it('"CSV stanu magazynowego": the products with stock and what to order (task 436)', async () => {
    const add = (body: object) =>
      ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201);
    const pomade = (
      await add({
        name: 'Pomada; mocna',
        priceGrosze: 4500,
        stockQuantity: 4,
        lowStockAt: 2,
        purchasePriceGrosze: 2050,
        supplier: 'Hairgum',
        // Task 523: the barcode is the last column.
        barcode: '5901234123457',
      })
    ).body as { id: string };
    // Task 469: pieces sold at the visits of the last 30 days — a sale of 40 days ago is not counted.
    for (const [days, quantity] of [
      [-3, 2],
      [-40, 1],
    ] as const) {
      const id = await visit({ date: addDays(today, days), status: 'completed', paid: true });
      await ctx
        .http()
        .post(`${base}/appointments/${id}/products`)
        .set(owner.auth)
        .send({ productId: pomade.id, quantity })
        .expect(201);
    }
    await add({ name: '=Aloes', priceGrosze: 3000, stockQuantity: 10, lowStockAt: 2 });
    await add({ name: 'Wosk', priceGrosze: 2550, supplier: 'Barber; Hurt' });
    await add({ name: 'Żel', priceGrosze: 2000, stockQuantity: 0 });
    const old = (await add({ name: 'Olejek', priceGrosze: 5000, stockQuantity: 0 })).body as {
      id: string;
    };
    await ctx
      .http()
      .patch(`${base}/products/${old.id}`)
      .set(owner.auth)
      .send({ active: false })
      .expect(200);

    const csv = (q: object = {}, auth = owner.auth) =>
      ctx
        .http()
        .get(`${base}/products/export.csv`)
        .query(q)
        .set(auth)
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => done(null, text));
        });
    const res = await csv().expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="stock-.+-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    // Sold products first, by name; a ";" is quoted and a leading "=" cannot run as a formula.
    expect(text.slice(1).trimEnd().split('\r\n')).toEqual([
      'Produkt;Cena;Sprzedajemy;W magazynie;Kończy się przy;Do zamówienia;Cena zakupu;Dostawca;Sprzedano w 30 dni;Kod kreskowy',
      "'=Aloes;30,00;tak;10;2;nie;;;0;",
      // Task 450: the purchase price; empty when not written. Task 462: then the supplier.
      '"Pomada; mocna";45,00;tak;1;2;tak;20,50;Hairgum;2;5901234123457',
      'Wosk;25,50;tak;;;nie;;"Barber; Hurt";0;',
      // Sold out: to order even without "Kończy się przy"; not when it is no longer sold.
      'Żel;20,00;tak;0;;tak;;;0;',
      'Olejek;50,00;nie;0;;nie;;;0;',
    ]);
    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain(
      'Product;Price;Sold;In stock;Runs low at;To order;Purchase price;Supplier;Sold in 30 days;Barcode',
    );
    expect(english).toContain('Wosk;25.50;yes;;;no;;"Barber; Hurt";0;');
    expect(english).toContain('"Pomada; mocna";45.00;yes;1;2;yes;20.50;Hairgum;2;5901234123457');
    await csv({ locale: 'de' }).expect(400);

    // Task 462: the list for one supplier only — the name in any letter case.
    const hairgum = (await csv({ supplier: 'HAIRGUM' }).expect(200)).body as string;
    expect(hairgum.slice(1).trimEnd().split('\r\n')).toEqual([
      'Produkt;Cena;Sprzedajemy;W magazynie;Kończy się przy;Do zamówienia;Cena zakupu;Dostawca;Sprzedano w 30 dni;Kod kreskowy',
      '"Pomada; mocna";45,00;tak;1;2;tak;20,50;Hairgum;2;5901234123457',
    ]);
    const nobody = (await csv({ supplier: 'Nikt' }).expect(200)).body as string;
    expect(nobody.slice(1).trimEnd().split('\r\n')).toHaveLength(1);

    // Task 469: only what to order — sold products that have run low or out.
    const toOrder = (await csv({ toOrder: 'true' }).expect(200)).body as string;
    expect(toOrder.slice(1).trimEnd().split('\r\n')).toEqual([
      'Produkt;Cena;Sprzedajemy;W magazynie;Kończy się przy;Do zamówienia;Cena zakupu;Dostawca;Sprzedano w 30 dni;Kod kreskowy',
      '"Pomada; mocna";45,00;tak;1;2;tak;20,50;Hairgum;2;5901234123457',
      'Żel;20,00;tak;0;;tak;;;0;',
    ]);
    const all = (await csv({ toOrder: 'false' }).expect(200)).body as string;
    expect(all.slice(1).trimEnd().split('\r\n')).toHaveLength(6);
    const hairgumToOrder = (await csv({ toOrder: 'true', supplier: 'hairgum' }).expect(200))
      .body as string;
    expect(hairgumToOrder.slice(1).trimEnd().split('\r\n')).toHaveLength(2);
    await csv({ toOrder: 'yes' }).expect(400);

    // A specialist cannot download it; another salon reaches nothing.
    await csv({}, kasiaUser.auth).expect(403);
    const other = await signUp(ctx, 'other-stock@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await csv({}, other.auth).expect(404);
  });

  it('"Kod kreskowy": the code on the package, one product per code in a salon (task 520)', async () => {
    const created = await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Pomada', priceGrosze: 4500, barcode: ' 5901234 123457 ' })
      .expect(201);
    // Spaces dropped, capital letters.
    expect(created.body).toMatchObject({ barcode: '5901234123457' });
    expect(registeredResponseSchema('Product').safeParse(created.body).error).toBeUndefined();
    const id = (created.body as { id: string }).id;
    const plain = await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Wosk', priceGrosze: 3000 })
      .expect(201);
    expect(plain.body).toMatchObject({ barcode: null });
    const waxId = (plain.body as { id: string }).id;
    // Too short, too long or other signs: refused.
    for (const barcode of ['12', '   ', 'x'.repeat(33), '590/123', 'ąę123']) {
      await ctx
        .http()
        .patch(`${base}/products/${waxId}`)
        .set(owner.auth)
        .send({ barcode })
        .expect(400);
    }
    const own = await ctx
      .http()
      .patch(`${base}/products/${waxId}`)
      .set(owner.auth)
      .send({ barcode: 'gst-wosk-1' })
      .expect(200);
    expect(own.body).toMatchObject({ barcode: 'GST-WOSK-1', priceGrosze: 3000 });
    // The same code on another product of the salon: 409, nothing changes.
    const taken = await ctx
      .http()
      .patch(`${base}/products/${waxId}`)
      .set(owner.auth)
      .send({ barcode: '5901234123457', name: 'Wosk mocny' })
      .expect(409);
    expectError(taken.body, 'BARCODE_TAKEN');
    const takenNew = await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Pomada 2', priceGrosze: 4500, barcode: 'gst-wosk-1' })
      .expect(409);
    expectError(takenNew.body, 'BARCODE_TAKEN');
    const names = (await ctx.http().get(`${base}/products`).set(owner.auth).expect(200)).body as {
      products: { name: string }[];
    };
    expect(names.products.map((p) => p.name).sort()).toEqual(['Pomada', 'Wosk']);
    // Writing its own code again is fine.
    await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(owner.auth)
      .send({ barcode: '5901234123457' })
      .expect(200);
    // A specialist sees the code (to find the product when noting a sale) but cannot change it.
    const list = (await ctx.http().get(`${base}/products`).set(kasiaUser.auth).expect(200))
      .body as { products: { id: string; name: string; barcode: string | null }[] };
    expect(list.products.find((p) => p.id === waxId)).toMatchObject({
      name: 'Wosk',
      barcode: 'GST-WOSK-1',
    });
    await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(kasiaUser.auth)
      .send({ barcode: '111111' })
      .expect(403);
    // Another salon may use the same code for its own product, and cannot change this one.
    const other = await signUp(ctx, 'other-barcode@example.com');
    const otherSalon = await createOrgWithLocation(ctx, other, 'Other');
    await ctx
      .http()
      .post(`/v1/organizations/${otherSalon.orgId}/locations/${otherSalon.locationId}/products`)
      .set(other.auth)
      .send({ name: 'Pomada', priceGrosze: 4000, barcode: '5901234123457' })
      .expect(201);
    await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(other.auth)
      .send({ barcode: '222222' })
      .expect(404);
    // null clears it; then the code is free again.
    const cleared = await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(owner.auth)
      .send({ barcode: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ barcode: null });
    await ctx
      .http()
      .patch(`${base}/products/${waxId}`)
      .set(owner.auth)
      .send({ barcode: '5901234123457' })
      .expect(200);
  });

  it('"Dostawca": whom the salon orders a product from; everyone in the salon sees it (task 462)', async () => {
    const created = await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Pomada', priceGrosze: 4500, supplier: '  Hairgum  ' })
      .expect(201);
    expect(created.body).toMatchObject({ supplier: 'Hairgum' });
    expect(registeredResponseSchema('Product').safeParse(created.body).error).toBeUndefined();
    const id = (created.body as { id: string }).id;
    const plain = await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Wosk', priceGrosze: 3000 })
      .expect(201);
    expect(plain.body).toMatchObject({ supplier: null });
    // Empty or too long: refused (null clears it).
    for (const supplier of ['   ', 'x'.repeat(81)]) {
      await ctx
        .http()
        .patch(`${base}/products/${id}`)
        .set(owner.auth)
        .send({ supplier })
        .expect(400);
    }
    const changed = await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(owner.auth)
      .send({ supplier: 'Reuzel' })
      .expect(200);
    expect(changed.body).toMatchObject({ supplier: 'Reuzel', priceGrosze: 4500 });
    // A specialist sees the supplier (to tell the owner what to order) but cannot change it.
    const list = (await ctx.http().get(`${base}/products`).set(kasiaUser.auth).expect(200))
      .body as { products: { id: string; supplier: string | null }[] };
    expect(list.products.find((p) => p.id === id)?.supplier).toBe('Reuzel');
    await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(kasiaUser.auth)
      .send({ supplier: 'Inny' })
      .expect(403);
    const cleared = await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(owner.auth)
      .send({ supplier: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ supplier: null });
    // Another salon cannot change it.
    const other = await signUp(ctx, 'other-supplier@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await ctx
      .http()
      .patch(`${base}/products/${id}`)
      .set(other.auth)
      .send({ supplier: 'Obcy' })
      .expect(404);
  });

  it('"CSV sprzedaży produktów": every product sold in the period, own visits for a specialist (task 422)', async () => {
    const product = async (name: string, priceGrosze: number) =>
      (
        await ctx
          .http()
          .post(`${base}/products`)
          .set(owner.auth)
          .send({ name, priceGrosze })
          .expect(201)
      ).body as { id: string };
    const pomade = await product('Pomada; mocna', 4500);
    const shampoo = await product('=Szampon', 3000);
    // Task 451: the pomade has a purchase price, the shampoo does not.
    await ctx
      .http()
      .patch(`${base}/products/${pomade.id}`)
      .set(owner.auth)
      .send({ purchasePriceGrosze: 2000 })
      .expect(200);
    const d1 = addDays(today, -3);
    const d2 = addDays(today, -1);
    const kasiaVisit = await visit({ date: d2, status: 'completed', paid: true });
    const olaVisit = await visit({ date: d1, staffId: olaId, status: 'completed', paid: true });
    const sell = (id: string, productId: string, quantity = 1) =>
      ctx
        .http()
        .post(`${base}/appointments/${id}/products`)
        .set(owner.auth)
        .send({ productId, quantity })
        .expect(201);
    await sell(kasiaVisit, pomade.id, 2);
    await sell(kasiaVisit, shampoo.id);
    await sell(olaVisit, shampoo.id);
    const csv = (q: object = {}, auth = owner.auth) =>
      ctx
        .http()
        .get(`${base}/reports/products-csv`)
        .query({ from, to: today, ...q })
        .set(auth)
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => done(null, text));
        });
    const res = await csv().expect(200);
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="products-.+-${from}-${today}\\.csv"$`),
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.slice(1).trimEnd().split('\r\n');
    // Oldest visit first; a ";" is quoted and a leading "=" cannot run as a formula.
    expect(lines).toEqual([
      'Data;Godzina;Specjalista;Produkt;Ilość;Cena;Wartość;Cena zakupu;Marża',
      expect.stringMatching(new RegExp(`^${d1};\\d\\d:\\d\\d;Ola;'=Szampon;1;30,00;30,00;;$`)),
      expect.stringMatching(
        new RegExp(`^${d2};\\d\\d:\\d\\d;Kasia;"Pomada; mocna";2;45,00;90,00;20,00;50,00$`),
      ),
      expect.stringMatching(new RegExp(`^${d2};\\d\\d:\\d\\d;Kasia;'=Szampon;1;30,00;30,00;;$`)),
      'Razem;;;;4;;150,00;;50,00',
    ]);
    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain(
      'Date;Time;Specialist;Product;Quantity;Price;Total;Purchase price;Margin',
    );
    expect(english).toContain('Total;;;;4;;150.00;;50.00');

    // A specialist: only with own results, and then only her own visits.
    await csv({}, kasiaUser.auth).expect(403);
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = (await csv({}, kasiaUser.auth).expect(200)).body as string;
    expect(own).not.toContain('Ola');
    // Without the salon's purchase prices.
    expect(own).toContain('Data;Godzina;Specjalista;Produkt;Ilość;Cena;Wartość\r\n');
    expect(own).not.toContain('Marża');
    expect(own).toContain('Razem;;;;3;;120,00\r\n');
    await csv({ from: today, to: from }).expect(400);

    // Another salon reaches nothing.
    const other = await signUp(ctx, 'other@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await csv({}, other.auth).expect(404);
  });

  it('"CSV historii magazynu": every change of the stock in the period, owners and managers only (task 454)', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({ name: 'Pomada; mocna', priceGrosze: 4500, stockQuantity: 2 });
    const wax = await add({ name: '=Wosk', priceGrosze: 3000 });
    await ctx
      .http()
      .post(`${base}/products/${wax.id}/restock`)
      .set(owner.auth)
      .send({ quantity: 5 })
      .expect(200);
    await ctx
      .http()
      .post(`${base}/products/${pomade.id}/write-off`)
      .set(owner.auth)
      .send({ quantity: 1, note: 'uszkodzone' })
      .expect(200);
    // An older change is outside the period.
    await ctx
      .http()
      .post(`${base}/products/${wax.id}/restock`)
      .set(owner.auth)
      .send({ quantity: 7 })
      .expect(200);
    await ctx.prisma.stockMovement.updateMany({
      where: { productId: wax.id, change: 7 },
      data: { createdAt: new Date(`${addDays(from, -3)}T12:00:00Z`) },
    });
    // Oldest first, whatever order the rows were written in.
    const first = await ctx.prisma.stockMovement.findFirstOrThrow({
      where: { productId: pomade.id, kind: 'correction' },
    });
    await ctx.prisma.stockMovement.update({
      where: { id: first.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    const csv = (q: object = {}, auth = owner.auth) =>
      ctx
        .http()
        .get(`${base}/reports/stock-history-csv`)
        .query({ from, to: today, ...q })
        .set(auth)
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => done(null, text));
        });
    const res = await csv().expect(200);
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="stock-history-.+-${from}-${today}\\.csv"$`),
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.slice(1).trimEnd().split('\r\n');
    const d = '\\d{4}-\\d\\d-\\d\\d;\\d\\d:\\d\\d';
    // A ";" is quoted and a leading "=" cannot run as a formula; who did it, the reason.
    expect(lines).toEqual([
      'Data;Godzina;Produkt;Zmiana;Sztuk;Stan po;Kto;Powód',
      expect.stringMatching(new RegExp(`^${d};"Pomada; mocna";Zmiana ręczna;\\+2;2;[^;]+;$`)),
      expect.stringMatching(new RegExp(`^${d};'=Wosk;Dostawa;\\+5;5;[^;]+;$`)),
      expect.stringMatching(new RegExp(`^${d};"Pomada; mocna";Odpis;-1;1;[^;]+;uszkodzone$`)),
    ]);
    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain('Date;Time;Product;Change;Pieces;In stock after;By;Reason');
    expect(english).toContain(';Write-off;-1;1;');

    // A specialist never gets the salon's stock, even with own results.
    await csv({}, kasiaUser.auth).expect(403);
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    await csv({}, kasiaUser.auth).expect(403);
    await csv({ from: today, to: from }).expect(400);

    // Another salon reaches nothing.
    const other = await signUp(ctx, 'other@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await csv({}, other.auth).expect(404);
  });

  it('every visit of the period as CSV for the accountant, without client contacts', async () => {
    const d1 = addDays(today, -3);
    const first = await visit({
      date: d1,
      status: 'completed',
      paid: true,
      method: 'card',
      discountGrosze: 1550,
      tipGrosze: 1000,
      online: true,
    });
    // Task 306: 4 zł of the discount is the client's tier, 11,50 zł coupons; happy hours took
    // 20 zł off the price before them.
    await ctx.prisma.appointment.update({
      where: { id: first },
      data: {
        tierDiscountGrosze: 400,
        tierName: 'Gold',
        tierDiscountPercent: 5,
        listPriceGrosze: 10000,
        happyHourPercent: 20,
      },
    });
    await visit({
      date: d1,
      staffId: olaId,
      serviceId: beardId,
      email: 'ewa@example.com',
      status: 'cancelled',
      cancelledBy: 'customer',
    });
    // Task 296: when the client cancelled — the day before at 18:30, the salon's time.
    await ctx.prisma.appointment.updateMany({
      where: { status: 'cancelled' },
      data: { cancelledAt: new Date(zonedToInstant(addDays(d1, -1), 18 * 60 + 30, TZ)) },
    });
    await visit({ date: addDays(today, -1), staffId: olaId, status: 'no_show' });
    // Task 257: the category of the service is the last column; Broda has none.
    const category = await ctx.prisma.serviceCategory.create({
      data: { locationId, name: 'Włosy' },
    });
    await ctx.prisma.service.update({
      where: { id: haircutId },
      data: { categoryId: category.id },
    });
    const csv = (q: object = {}, auth = owner.auth) =>
      ctx
        .http()
        .get(`${base}/reports/visits-csv`)
        .query({ from, to: today, ...q })
        .set(auth)
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => done(null, text));
        });

    // Task 377: Kasia gets 40% — her paid visit has the commission in the last column.
    await ctx.prisma.staffMember.update({
      where: { id: kasiaId },
      data: { commissionPermille: 400 },
    });
    // Task 426: products sold at Kasia's visit — 2 × 25,00 + 20,00 = 70,00 in the last column.
    await ctx.prisma.productSale.createMany({
      data: [
        { locationId, appointmentId: first, name: 'Wosk', quantity: 2, unitPriceGrosze: 2500 },
        { locationId, appointmentId: first, name: 'Szampon', quantity: 1, unitPriceGrosze: 2000 },
      ],
    });
    // Task 544: 30,00 paid for Kasia's visit with a gift voucher; a payment undone by
    // "Cofnij płatność" and one at the till without a visit do not count.
    const voucher = await ctx.prisma.giftVoucher.create({
      data: { locationId, code: 'CSV544AB', amountGrosze: 10000, balanceGrosze: 5000 },
    });
    await ctx.prisma.giftVoucherUse.createMany({
      data: [
        { voucherId: voucher.id, amountGrosze: 3000, appointmentId: first },
        { voucherId: voucher.id, amountGrosze: 1000, appointmentId: first, undoneAt: new Date() },
        { voucherId: voucher.id, amountGrosze: 2000 },
      ],
    });
    const res = await csv().expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="visits-.+-${from}-${today}\\.csv"$`),
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines).toEqual([
      'Data;Godzina;Specjalista;Usługa;Klient;Status;Rezerwacja;Cena;Rabat;Do zapłaty;Opłacono;Sposób płatności;Napiwek;Kategoria;Odwołano (kiedy);Kupony;Rabat poziomu;Happy hours;Prowizja;Produkty;Zapłacono bonem',
      `${d1};12:00;Kasia;Strzyżenie;Jan Nowak;Odbyła się;Online;80,00;15,50;64,50;tak;karta;10,00;Włosy;;11,50;4,00;20,00;25,80;70,00;30,00`,
      `${d1};12:00;Ola;Broda;Jan Nowak;Odwołana przez klienta;Salon;50,00;0,00;50,00;nie;;0,00;;${addDays(d1, -1)} 18:30;;;;;;`,
      `${addDays(today, -1)};12:00;Ola;Strzyżenie;Jan Nowak;Nie przyszedł;Salon;80,00;0,00;80,00;nie;;0,00;Włosy;;;;;;;`,
    ]);
    expect(text).not.toContain('+48600000002');
    expect(text).not.toContain('@example.com');

    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain('Date;Time;Specialist;Service;Client;Status;Booked;Price');
    expect(english).toContain(
      'To pay;Paid;Payment method;Tip;Category;Cancelled at;Coupons;Tier discount;Happy hours;Commission;Products;Paid with voucher',
    );
    expect(english).toContain(
      ';Completed;Online;80.00;15.50;64.50;yes;card;10.00;Włosy;;11.50;4.00;20.00;25.80;70.00;30.00',
    );

    // The same access as the report.
    await csv({}, kasiaUser.auth).expect(403);
    await ctx.prisma.membership.update({
      where: { id: kasiaMembershipId },
      data: { permissionOverrides: { viewOwnEarnings: true } },
    });
    const own = (await csv({}, kasiaUser.auth).expect(200)).body as string;
    expect(own.trimEnd().split('\r\n')).toHaveLength(2);
    expect(own).not.toContain(';Ola;');
    await csv({ from: today, to: from }).expect(400);
    await csv({ locale: 'xx' }).expect(400);
  });

  it('a client name that looks like a formula stays text', () => {
    const row = {
      date: '2026-11-03',
      time: '10:00',
      staff: 'Kasia',
      service: 'Cut; wash',
      client: '=HYPERLINK("x")',
      status: 'completed' as const,
      cancelledBy: null,
      online: false,
      priceGrosze: 100,
      discountGrosze: 0,
      paid: true,
      method: null,
      tipGrosze: 0,
      category: '-Hair',
      cancelledAt: null,
      tierDiscountGrosze: 0,
      happyHourGrosze: 0,
      commissionGrosze: null,
      productsGrosze: 0,
      voucherGrosze: 0,
    };
    expect(visitsCsv([row], 'pl').split('\r\n')[1]).toBe(
      `2026-11-03;10:00;Kasia;"Cut; wash";"'=HYPERLINK(""x"")";Odbyła się;Salon;1,00;0,00;1,00;tak;;0,00;'-Hair;;;;;;;`,
    );
  });
});
