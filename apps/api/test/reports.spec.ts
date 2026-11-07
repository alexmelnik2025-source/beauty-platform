import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { occupancy } from '../src/reports/occupancy';
import { visitsCsv } from '../src/reports/visits-csv';
import { addDays, isoWeekday, localToday, zonedToInstant } from '../src/scheduling/time';
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

  it('"Obłożenie": working time by the schedule and the part visits took (task 141)', async () => {
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
    expect(res.body.occupancy).toEqual({
      workMinutes: work,
      bookedMinutes: 60,
      percent: Math.round((60 / work) * 100),
      staff: [
        {
          id: kasiaId,
          displayName: 'Kasia',
          workMinutes: work,
          bookedMinutes: 60,
          percent: Math.round((60 / work) * 100),
        },
        { id: olaId, displayName: 'Ola', workMinutes: 0, bookedMinutes: 0, percent: 0 },
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
    await review({ date: d1, staffId: olaId, status: 'completed' }, 2);
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
    });

    // No reviews in a period: no average.
    const empty = await report(owner.auth, { from: addDays(today, -60), to: addDays(today, -50) });
    expect(empty.body.ratings).toEqual({
      reviews: 0,
      average: null,
      stars: [0, 0, 0, 0, 0],
      staff: [],
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
  it('every visit of the period as CSV for the accountant, without client contacts', async () => {
    const d1 = addDays(today, -3);
    await visit({ date: d1, status: 'completed', paid: true, discountGrosze: 1550, online: true });
    await visit({
      date: d1,
      staffId: olaId,
      serviceId: beardId,
      email: 'ewa@example.com',
      status: 'cancelled',
      cancelledBy: 'customer',
    });
    await visit({ date: addDays(today, -1), staffId: olaId, status: 'no_show' });
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

    const res = await csv().expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="visits-.+-${from}-${today}\\.csv"$`),
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines).toEqual([
      'Data;Godzina;Specjalista;Usługa;Klient;Status;Rezerwacja;Cena;Rabat;Do zapłaty;Opłacono',
      `${d1};12:00;Kasia;Strzyżenie;Jan Nowak;Odbyła się;Online;80,00;15,50;64,50;tak`,
      `${d1};12:00;Ola;Broda;Jan Nowak;Odwołana przez klienta;Salon;50,00;0,00;50,00;nie`,
      `${addDays(today, -1)};12:00;Ola;Strzyżenie;Jan Nowak;Nie przyszedł;Salon;80,00;0,00;80,00;nie`,
    ]);
    expect(text).not.toContain('+48600000002');
    expect(text).not.toContain('@example.com');

    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain('Date;Time;Specialist;Service;Client;Status;Booked;Price');
    expect(english).toContain(';Completed;Online;80.00;15.50;64.50;yes');

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
    };
    expect(visitsCsv([row], 'pl').split('\r\n')[1]).toBe(
      `2026-11-03;10:00;Kasia;"Cut; wash";"'=HYPERLINK(""x"")";Odbyła się;Salon;1,00;0,00;1,00;tak`,
    );
  });
});
