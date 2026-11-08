import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { favorite, rhythm, usualPayment } from '../src/booking/customers.service';
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
      rhythmDays: null,
      favoriteService: null,
      favoriteStaff: null,
      paid: [],
      tips: [],
      usualPayment: null,
      ratings: null,
    });
  });

  it('counts visits, no-shows and cancellations; the paid sum is after coupons', async () => {
    const first = await pastVisit(kasiaId, 30);
    const second = await pastVisit(tomekId, 10);
    const latest = await pastVisit(kasiaId, 2, false);
    // Task 290: both paid visits by card; the unpaid one has no method.
    await ctx.prisma.appointment.updateMany({
      where: { id: { in: [first, second] } },
      data: { paymentMethod: 'card' },
    });
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
    // Task 287: tips on two of the visits that took place (one of them not paid yet); a tip on
    // the no-show does not count.
    await ctx.prisma.appointment.update({ where: { id: first }, data: { tipGrosze: 1000 } });
    await ctx.prisma.appointment.update({ where: { id: latest }, data: { tipGrosze: 550 } });
    await ctx.prisma.appointment.update({ where: { id: missed }, data: { tipGrosze: 9900 } });

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
      // Task 250: 20 and 8 days between the three visits.
      rhythmDays: 14,
      // Task 261: three haircuts, two of them at Kasia's.
      favoriteService: { name: 'Strzyżenie', visits: 3 },
      favoriteStaff: { name: 'Kasia', visits: 2 },
      // Task 285: two paid visits (the third is not paid yet).
      paid: [{ currency: 'PLN', amountGrosze: 6000 + 8000, visits: 2 }],
      // Task 287: 10 zł + 5,50 zł on two visits.
      tips: [{ currency: 'PLN', amountGrosze: 1550, visits: 2 }],
      usualPayment: { method: 'card', visits: 2 },
      ratings: null,
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
    expect(body.summary).toMatchObject({
      completed: 1,
      noShow: 1,
      upcoming: 0,
      paid: null,
      tips: null,
      usualPayment: null,
      // Task 261: one own visit is not a habit.
      favoriteService: null,
      favoriteStaff: null,
    });
  });

  it('"Oceny": the reviews the client left, as far as the caller sees the visits (task 301)', async () => {
    const atKasia = await pastVisit(kasiaId, 30);
    const atTomek = await pastVisit(tomekId, 10);
    const later = await pastVisit(tomekId, 5);
    await ctx.prisma.visitReview.createMany({
      data: [
        { appointmentId: atKasia, locationId, staffId: kasiaId, rating: 5 },
        { appointmentId: atTomek, locationId, staffId: tomekId, rating: 4 },
        { appointmentId: later, locationId, staffId: tomekId, rating: 4 },
      ],
    });
    // A review by another client does not count.
    const other = (
      await ctx
        .http()
        .post(customersBase)
        .set(owner.auth)
        .send({ name: 'Ewa', phone: '+48600000003' })
        .expect(201)
    ).body.id as string;
    const keep = customerId;
    customerId = other;
    const hers = await pastVisit(kasiaId, 3);
    customerId = keep;
    await ctx.prisma.visitReview.create({
      data: { appointmentId: hers, locationId, staffId: kasiaId, rating: 1 },
    });

    const { body } = await card(owner.auth);
    expect(registeredResponseSchema('CustomerDetail').safeParse(body).error?.issues ?? []).toEqual(
      [],
    );
    expect(body.summary.ratings).toEqual({ reviews: 3, average: 4.3 });
    expect((await card(manager.auth)).body.summary.ratings).toEqual({ reviews: 3, average: 4.3 });
    // A specialist without the client history sees only the review of her own visit.
    await ctx.prisma.membership.updateMany({
      where: { userId: kasia.userId },
      data: { permissionOverrides: { viewClientHistory: false } },
    });
    expect((await card(kasia.auth)).body.summary.ratings).toEqual({ reviews: 1, average: 5 });
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
        tipGrosze: 5000,
      },
    });
    const { body } = await card(owner.auth);
    expect(body.summary.paid).toEqual([
      { currency: 'CZK', amountGrosze: 50000, visits: 1 },
      { currency: 'PLN', amountGrosze: 8000, visits: 1 },
    ]);
    expect(body.summary.completed).toBe(2);
    // Task 287: the tip in the Prague salon is in crowns.
    expect(body.summary.tips).toEqual([{ currency: 'CZK', amountGrosze: 5000, visits: 1 }]);
  });
});

describe('"Wraca zwykle co N dni" (task 250)', () => {
  it('the median of the gaps; same-day visits are one; fewer than three visits — none', () => {
    const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 0, day, hour));
    expect(rhythm([])).toBeNull();
    expect(rhythm([at(1), at(29)])).toBeNull();
    // Two services on one day count once.
    expect(rhythm([at(1), at(1, 13), at(29)])).toBeNull();
    expect(rhythm([at(1), at(29), at(29, 13), at(31)])).toBe(15);
    expect(rhythm([at(1), at(22), at(29), at(31)])).toBe(7);
  });
});

describe('"Zwykle płaci" (task 290)', () => {
  it('the most frequent method; the latest wins a tie; below two visits — none', () => {
    const rows = (...methods: ('cash' | 'card' | 'blik')[]) =>
      methods.map((paymentMethod) => ({ paymentMethod }));
    expect(usualPayment(rows('cash', 'card', 'cash'))).toEqual({ method: 'cash', visits: 2 });
    expect(usualPayment(rows('cash', 'card', 'card', 'cash'))).toEqual({
      method: 'cash',
      visits: 2,
    });
    expect(usualPayment(rows('blik'))).toBeNull();
    expect(usualPayment([{ paymentMethod: null }, { paymentMethod: null }])).toBeNull();
    expect(usualPayment(null)).toBeNull();
  });
});

describe('favourite service and specialist (task 261)', () => {
  it('the most frequent name; the latest wins a tie; below two visits — none', () => {
    expect(favorite([])).toBeNull();
    expect(favorite(['Strzyżenie'])).toBeNull();
    expect(favorite(['Strzyżenie', 'Broda'])).toBeNull();
    expect(favorite(['Strzyżenie', 'Broda', 'Strzyżenie'])).toEqual({
      name: 'Strzyżenie',
      visits: 2,
    });
    expect(favorite(['Strzyżenie', 'Broda', 'Strzyżenie', 'Broda'])).toEqual({
      name: 'Broda',
      visits: 2,
    });
  });
});

describe('"Haven\'t been for a while" (task 140)', () => {
  const list = (query: string, auth = owner.auth) =>
    ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200);

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  it('lists clients who came before but not in the last N days and have nothing booked', async () => {
    // Jan: last came 70 days ago → inactive for 60 days, not for 90.
    await pastVisit(kasiaId, 70);
    const ewa = await client('Ewa Dawna', '+48600000003');
    const olek = await client('Olek Wraca', '+48600000004');
    await client('Nowy Bez Wizyt', '+48600000005');
    // Ewa came 100 days ago.
    customerId = ewa;
    await pastVisit(kasiaId, 100);
    // Olek came 100 days ago but has booked again.
    customerId = olek;
    await pastVisit(tomekId, 100);
    await futureVisit(tomekId, 2);

    const names = async (q: string) => (await list(q)).body.map((c: { name: string }) => c.name);
    expect(await names('inactiveDays=60')).toEqual(['Ewa Dawna', 'Jan Nowak']);
    expect(await names('inactiveDays=90')).toEqual(['Ewa Dawna']);
    expect(await names('inactiveDays=60&search=ewa')).toEqual(['Ewa Dawna']);
    // Without the filter everyone is listed.
    expect(await names('limit=100')).toHaveLength(4);
    // The manager sees the same in the salon.
    expect(
      (await list('inactiveDays=60', manager.auth)).body.map((c: { name: string }) => c.name),
    ).toEqual(['Ewa Dawna', 'Jan Nowak']);
  });

  it('too short or too long periods are refused', async () => {
    await ctx.http().get(`${customersBase}?inactiveDays=7`).set(owner.auth).expect(400);
    await ctx.http().get(`${customersBase}?inactiveDays=1000`).set(owner.auth).expect(400);
  });
});

describe('"Nowi klienci" (task 248)', () => {
  const names = async (query: string, auth = owner.auth) =>
    (await ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200)).body.map(
      (c: { name: string }) => c.name,
    );

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  it('lists clients whose first visit was in the last N days, newest first', async () => {
    // Jan: first came 5 days ago.
    await pastVisit(kasiaId, 5);
    // Ewa: first came 40 days ago, again 3 days ago — not new for 30 days.
    customerId = await client('Ewa Stała', '+48600000003');
    await pastVisit(kasiaId, 40);
    await pastVisit(kasiaId, 3);
    // Olek: first came 2 days ago and has booked again.
    customerId = await client('Olek Nowy', '+48600000004');
    await pastVisit(tomekId, 2);
    await futureVisit(tomekId, 2);
    // Adam has only a booked visit; Bez Wizyt never came.
    customerId = await client('Adam Zapisany', '+48600000005');
    await futureVisit(kasiaId, 3);
    await client('Bez Wizyt', '+48600000006');

    expect(await names('newDays=30')).toEqual(['Olek Nowy', 'Jan Nowak']);
    expect(await names('newDays=60')).toEqual(['Olek Nowy', 'Jan Nowak', 'Ewa Stała']);
    expect(await names('newDays=30&search=jan')).toEqual(['Jan Nowak']);
    expect(await names('newDays=60&limit=1')).toEqual(['Olek Nowy']);
    // The manager sees the same in the salon.
    expect(await names('newDays=30', manager.auth)).toEqual(['Olek Nowy', 'Jan Nowak']);
    // Without the filter, everyone.
    expect(await names('limit=100')).toHaveLength(5);
    await ctx.http().get(`${customersBase}?newDays=3`).set(owner.auth).expect(400);
    await ctx.http().get(`${customersBase}?newDays=365`).set(owner.auth).expect(400);
  });

  it('"Pokaż więcej": the next page with offset, also on a filtered list (task 277)', async () => {
    // Jan: first came 5 days ago; Ewa — 3 days ago; Olek — 2 days ago.
    await pastVisit(kasiaId, 5);
    customerId = await client('Ewa Nowa', '+48600000003');
    await pastVisit(kasiaId, 3);
    customerId = await client('Olek Nowy', '+48600000004');
    await pastVisit(tomekId, 2);
    await client('Adam Bez Wizyt', '+48600000005');

    expect(await names('limit=2')).toEqual(['Adam Bez Wizyt', 'Ewa Nowa']);
    expect(await names('limit=2&offset=2')).toEqual(['Jan Nowak', 'Olek Nowy']);
    expect(await names('limit=2&offset=4')).toEqual([]);
    // A filtered list keeps its own order from page to page.
    expect(await names('newDays=30&limit=2')).toEqual(['Olek Nowy', 'Ewa Nowa']);
    expect(await names('newDays=30&limit=2&offset=2')).toEqual(['Jan Nowak']);
    expect(await names('newDays=30&limit=2&offset=2', manager.auth)).toEqual(['Jan Nowak']);
    await ctx.http().get(`${customersBase}?offset=-1`).set(owner.auth).expect(400);
  });

  it("another organization's clients do not leak", async () => {
    await pastVisit(kasiaId, 5);
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    const theirs = await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/customers?newDays=30`)
      .set(stranger.auth)
      .expect(200);
    expect(theirs.body).toEqual([]);
    expect(await names('newDays=30')).toEqual(['Jan Nowak']);
  });
});

describe('"Pora wrócić" (task 262)', () => {
  const names = async (query: string, auth = owner.auth) =>
    (await ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200)).body.map(
      (c: { name: string }) => c.name,
    );

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  it('lists clients past their usual break with nothing booked, the most recently due first', async () => {
    // Jan: every 20 days, last 30 days ago — due 10 days ago.
    await pastVisit(kasiaId, 70);
    await pastVisit(kasiaId, 50);
    await pastVisit(kasiaId, 30);
    // Piotr: every 15 days, last 15 days ago — due just now.
    customerId = await client('Piotr Zwykły', '+48600000003');
    await pastVisit(tomekId, 45);
    await pastVisit(tomekId, 30);
    await pastVisit(tomekId, 15);
    // Ewa: every 8 days, last 4 days ago — due in 4 days.
    customerId = await client('Ewa Wcześnie', '+48600000004');
    await pastVisit(kasiaId, 20);
    await pastVisit(kasiaId, 12);
    await pastVisit(kasiaId, 4);
    // Ola: due, but already booked.
    customerId = await client('Ola Zapisana', '+48600000005');
    await pastVisit(kasiaId, 45);
    await pastVisit(kasiaId, 30);
    await pastVisit(kasiaId, 15);
    await futureVisit(kasiaId, 2);
    // Adam: two visits are not a habit yet.
    customerId = await client('Adam Dwa', '+48600000006');
    await pastVisit(kasiaId, 100);
    await pastVisit(kasiaId, 50);

    expect(await names('overdue=yes')).toEqual(['Piotr Zwykły', 'Jan Nowak']);
    expect(await names('overdue=yes&search=jan')).toEqual(['Jan Nowak']);
    expect(await names('overdue=yes&limit=1')).toEqual(['Piotr Zwykły']);
    expect(await names('overdue=yes', manager.auth)).toEqual(['Piotr Zwykły', 'Jan Nowak']);
    expect(await names('limit=100')).toHaveLength(5);
    await ctx.http().get(`${customersBase}?overdue=no`).set(owner.auth).expect(400);
  });

  it("another organization's clients do not leak", async () => {
    await pastVisit(kasiaId, 70);
    await pastVisit(kasiaId, 50);
    await pastVisit(kasiaId, 30);
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    const theirs = await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/customers?overdue=yes`)
      .set(stranger.auth)
      .expect(200);
    expect(theirs.body).toEqual([]);
    expect(await names('overdue=yes')).toEqual(['Jan Nowak']);
  });
});

describe('"Nie przyszli" (task 264)', () => {
  const names = async (query: string, auth = owner.auth) =>
    (await ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200)).body.map(
      (c: { name: string }) => c.name,
    );

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  async function noShow(staffId: string, daysAgo: number): Promise<void> {
    const id = await pastVisit(staffId, daysAgo, false);
    await ctx.prisma.appointment.update({ where: { id }, data: { status: 'no_show' } });
  }

  it('lists clients who did not come in the last year, the most recent no-show first', async () => {
    // Jan: did not come 40 days ago (and came later).
    await noShow(kasiaId, 40);
    await pastVisit(kasiaId, 10);
    // Piotr: did not come 5 days ago.
    customerId = await client('Piotr Spóźniony', '+48600000003');
    await noShow(tomekId, 5);
    // Ewa: did not come, but 400 days ago — too long ago.
    customerId = await client('Ewa Dawno', '+48600000004');
    await noShow(kasiaId, 400);
    // Ola: always comes.
    customerId = await client('Ola Słowna', '+48600000005');
    await pastVisit(kasiaId, 20);

    expect(await names('noShows=yes')).toEqual(['Piotr Spóźniony', 'Jan Nowak']);
    expect(await names('noShows=yes&search=jan')).toEqual(['Jan Nowak']);
    expect(await names('noShows=yes&limit=1')).toEqual(['Piotr Spóźniony']);
    expect(await names('noShows=yes', manager.auth)).toEqual(['Piotr Spóźniony', 'Jan Nowak']);
    expect(await names('limit=100')).toHaveLength(4);
    await ctx.http().get(`${customersBase}?noShows=no`).set(owner.auth).expect(400);
    await ctx.http().get(`${customersBase}?noShows=yes`).set(kasia.auth).expect(403);
  });

  it("another organization's clients do not leak", async () => {
    await noShow(kasiaId, 3);
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    const theirs = await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/customers?noShows=yes`)
      .set(stranger.auth)
      .expect(200);
    expect(theirs.body).toEqual([]);
    expect(await names('noShows=yes')).toEqual(['Jan Nowak']);
  });
});

describe('"Byli raz" (task 270)', () => {
  const names = async (query: string, auth = owner.auth) =>
    (await ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200)).body.map(
      (c: { name: string }) => c.name,
    );

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  it('lists clients who came on one day only, 30–365 days ago, with nothing booked', async () => {
    // Jan: one visit 40 days ago — two services that day are still one visit.
    await pastVisit(kasiaId, 40);
    await pastVisit(tomekId, 40);
    // Piotr: one visit 100 days ago.
    customerId = await client('Piotr Raz', '+48600000003');
    await pastVisit(tomekId, 100);
    // Ewa: came twice.
    customerId = await client('Ewa Dwa', '+48600000004');
    await pastVisit(kasiaId, 90);
    await pastVisit(kasiaId, 60);
    // Ola: one visit, but only 10 days ago — still new ("Nowi (30 dni)").
    customerId = await client('Ola Nowa', '+48600000005');
    await pastVisit(kasiaId, 10);
    // Adam: one visit 50 days ago, but already booked again.
    customerId = await client('Adam Wraca', '+48600000006');
    await pastVisit(kasiaId, 50);
    await futureVisit(kasiaId, 3);
    // Iza: one visit 400 days ago — too long ago.
    customerId = await client('Iza Dawno', '+48600000007');
    await pastVisit(kasiaId, 400);

    expect(await names('once=yes')).toEqual(['Jan Nowak', 'Piotr Raz']);
    expect(await names('once=yes&search=piotr')).toEqual(['Piotr Raz']);
    expect(await names('once=yes&limit=1')).toEqual(['Jan Nowak']);
    expect(await names('once=yes', manager.auth)).toEqual(['Jan Nowak', 'Piotr Raz']);
    expect(await names('limit=100')).toHaveLength(6);
    await ctx.http().get(`${customersBase}?once=no`).set(owner.auth).expect(400);
    await ctx.http().get(`${customersBase}?once=yes`).set(kasia.auth).expect(403);
  });

  it("another organization's clients do not leak", async () => {
    await pastVisit(kasiaId, 45);
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    const theirs = await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/customers?once=yes`)
      .set(stranger.auth)
      .expect(200);
    expect(theirs.body).toEqual([]);
    expect(await names('once=yes')).toEqual(['Jan Nowak']);
  });
});

describe('numbers next to the quick filters (task 273)', () => {
  async function client(name: string, phone: string, birthday?: string): Promise<string> {
    return (
      await ctx
        .http()
        .post(customersBase)
        .set(owner.auth)
        .send({ name, phone, ...(birthday ? { birthday } : {}) })
        .expect(201)
    ).body.id;
  }

  const segments = async (auth: Record<string, string>, path = customersBase) => {
    const res = await ctx.http().get(`${path}/segments`).set(auth).expect(200);
    expect(
      registeredResponseSchema('CustomerSegments').safeParse(res.body).error?.issues ?? [],
    ).toEqual([]);
    return res.body;
  };

  /** Two days ahead (UTC) — inside the 7-day window whatever the salon's time zone. */
  const soon = () => new Date(Date.now() + 2 * DAY).toISOString().slice(5, 10);

  it('counts each filter with the same rules as the list; managers only their salons', async () => {
    // Jan: did not come 40 days ago, came 10 days ago — new (first visit that took place) and a no-show.
    const missed = await pastVisit(kasiaId, 40, false);
    await ctx.prisma.appointment.update({ where: { id: missed }, data: { status: 'no_show' } });
    await pastVisit(kasiaId, 10);
    // Piotr: came once, 100 days ago.
    customerId = await client('Piotr Raz', '+48600000003');
    await pastVisit(tomekId, 100);
    // Adam: every 20 days, last 30 days ago — due.
    customerId = await client('Adam Stały', '+48600000004');
    await pastVisit(kasiaId, 70);
    await pastVisit(kasiaId, 50);
    await pastVisit(kasiaId, 30);
    // Ewa: no visits, a birthday soon, agreed to the salon messages.
    const ewa = await client('Ewa Urodziny', '+48600000005', soon());
    await ctx.prisma.consentRecord.create({
      data: { customerId: ewa, type: 'marketing', version: 'test', granted: true },
    });
    // Erased clients are not counted.
    const gone = await client('Usunięta', '+48600000006', soon());
    await ctx
      .http()
      .post(`${customersBase}/${gone}/anonymize`)
      .set(owner.auth)
      .send({ version: 1 })
      .expect(200);

    expect(await segments(owner.auth)).toEqual({
      birthdays: 1,
      consented: 1,
      newcomers: 1,
      overdue: 1,
      noShows: 1,
      once: 1,
    });
    // The numbers match the lists.
    const count = async (query: string) =>
      (await ctx.http().get(`${customersBase}?${query}`).set(owner.auth).expect(200)).body.length;
    expect(await count('newDays=30')).toBe(1);
    expect(await count('overdue=yes')).toBe(1);
    expect(await count('noShows=yes')).toBe(1);
    expect(await count('once=yes')).toBe(1);
    expect(await count('birthdayDays=7')).toBe(1);
    expect(await count('marketing=yes')).toBe(1);
    // A manager sees only clients with visits in their salons: Ewa has none.
    expect(await segments(manager.auth)).toEqual({
      birthdays: 0,
      consented: 0,
      newcomers: 1,
      overdue: 1,
      noShows: 1,
      once: 1,
    });
    // Specialists do not get the client list.
    await ctx.http().get(`${customersBase}/segments`).set(kasia.auth).expect(403);
  });

  it("another organization's clients do not leak", async () => {
    await pastVisit(kasiaId, 45);
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    expect(await segments(stranger.auth, `/v1/organizations/${other.orgId}/customers`)).toEqual({
      birthdays: 0,
      consented: 0,
      newcomers: 0,
      overdue: 0,
      noShows: 0,
      once: 0,
    });
    await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/customers/segments`)
      .set(owner.auth)
      .expect(404);
    expect((await segments(owner.auth)).once).toBe(1);
  });
});

describe('sorting the client list (task 279)', () => {
  const names = async (query: string, auth = owner.auth) =>
    (await ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200)).body.map(
      (c: { name: string }) => c.name,
    );

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  it('by name, by the latest visit or by the number of visits', async () => {
    // Jan: three visits, the latest 20 days ago.
    await pastVisit(kasiaId, 60);
    await pastVisit(kasiaId, 40);
    await pastVisit(kasiaId, 20);
    // Ewa: one visit 2 days ago and one booked (a booked visit does not count).
    customerId = await client('Ewa Świeża', '+48600000003');
    await pastVisit(tomekId, 2);
    await futureVisit(tomekId, 3);
    // Olek: two visits, the latest 10 days ago.
    customerId = await client('Olek Średni', '+48600000004');
    await pastVisit(kasiaId, 30);
    await pastVisit(kasiaId, 10);
    // Adam and Bartek never came.
    await client('Bartek Bez Wizyt', '+48600000005');
    await client('Adam Bez Wizyt', '+48600000006');

    const all = ['Adam Bez Wizyt', 'Bartek Bez Wizyt', 'Ewa Świeża', 'Jan Nowak', 'Olek Średni'];
    expect(await names('')).toEqual(all);
    expect(await names('sort=name')).toEqual(all);
    expect(await names('sort=recent')).toEqual([
      'Ewa Świeża',
      'Olek Średni',
      'Jan Nowak',
      'Adam Bez Wizyt',
      'Bartek Bez Wizyt',
    ]);
    expect(await names('sort=visits')).toEqual([
      'Jan Nowak',
      'Olek Średni',
      'Ewa Świeża',
      'Adam Bez Wizyt',
      'Bartek Bez Wizyt',
    ]);
    // Pages keep the order.
    expect(await names('sort=recent&limit=2&offset=1')).toEqual(['Olek Średni', 'Jan Nowak']);
    // With a search or a label it sorts what is found.
    expect(await names('sort=visits&search=a')).toEqual([
      'Jan Nowak',
      'Ewa Świeża',
      'Adam Bez Wizyt',
      'Bartek Bez Wizyt',
    ]);
    // A filter with its own order keeps it.
    expect(await names('sort=visits&newDays=7')).toEqual(['Ewa Świeża']);
    // The manager: the salon's clients in the same order.
    expect(await names('sort=recent', manager.auth)).toEqual([
      'Ewa Świeża',
      'Olek Średni',
      'Jan Nowak',
    ]);
    await ctx.http().get(`${customersBase}?sort=price`).set(owner.auth).expect(400);
  });

  it('counts only visits in the salons the manager works in', async () => {
    const other = await ctx.prisma.location.create({
      data: {
        organizationId: orgId,
        name: 'Drugi',
        slug: 'drugi-279',
        addressLine: 'Prosta 1',
        city: 'Warszawa',
        postalCode: '00-001',
      },
    });
    // Jan: one visit here; Ewa: one here and three in the other salon (moved there directly).
    await pastVisit(kasiaId, 5);
    customerId = await client('Ewa Dwa Salony', '+48600000003');
    await pastVisit(tomekId, 15);
    for (const days of [40, 30, 20]) {
      const id = await pastVisit(tomekId, days);
      await ctx.prisma.appointment.update({ where: { id }, data: { locationId: other.id } });
    }
    expect(await names('sort=visits')).toEqual(['Ewa Dwa Salony', 'Jan Nowak']);
    // The manager works only in the first salon: one visit each there (then by name), and Jan's
    // is the more recent.
    expect(await names('sort=visits', manager.auth)).toEqual(['Ewa Dwa Salony', 'Jan Nowak']);
    expect(await names('sort=recent', manager.auth)).toEqual(['Jan Nowak', 'Ewa Dwa Salony']);
  });
});

describe('the nearest booked visit first (task 281)', () => {
  const names = async (query: string, auth = owner.auth) =>
    (await ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200)).body.map(
      (c: { name: string }) => c.name,
    );

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  it('booked clients by the nearest visit, then everyone else by name', async () => {
    // Jan: booked in 5 and in 2 days — the nearest is in 2 days.
    await futureVisit(kasiaId, 5);
    await futureVisit(kasiaId, 2);
    // Ewa: booked tomorrow.
    customerId = await client('Ewa Jutro', '+48600000003');
    await futureVisit(tomekId, 1);
    // Olek: only past visits and a cancelled booking — counts as nothing booked.
    customerId = await client('Olek Bez Rezerwacji', '+48600000004');
    await pastVisit(kasiaId, 10);
    const cancelled = await futureVisit(kasiaId, 1);
    await ctx.prisma.appointment.update({
      where: { id: cancelled },
      data: { status: 'cancelled', cancelledBy: 'customer' },
    });
    await client('Adam Nikt', '+48600000005');

    expect(await names('sort=next')).toEqual([
      'Ewa Jutro',
      'Jan Nowak',
      'Adam Nikt',
      'Olek Bez Rezerwacji',
    ]);
    // Pages keep the order.
    expect(await names('sort=next&limit=2&offset=1')).toEqual(['Jan Nowak', 'Adam Nikt']);
    // The manager sees the same order for the salon's clients.
    expect(await names('sort=next', manager.auth)).toEqual([
      'Ewa Jutro',
      'Jan Nowak',
      'Olek Bez Rezerwacji',
    ]);
  });

  it('counts only bookings in the salons the manager works in', async () => {
    const other = await ctx.prisma.location.create({
      data: {
        organizationId: orgId,
        name: 'Drugi',
        slug: 'drugi-281',
        addressLine: 'Prosta 1',
        city: 'Warszawa',
        postalCode: '00-001',
      },
    });
    await futureVisit(kasiaId, 3);
    customerId = await client('Ewa Dwa Salony', '+48600000003');
    await futureVisit(tomekId, 6);
    const there = await futureVisit(tomekId, 1);
    await ctx.prisma.appointment.update({ where: { id: there }, data: { locationId: other.id } });
    // The owner: Ewa's visit tomorrow in the other salon is the nearest.
    expect(await names('sort=next')).toEqual(['Ewa Dwa Salony', 'Jan Nowak']);
    // The manager works only in the first salon: Jan in 3 days, Ewa in 6.
    expect(await names('sort=next', manager.auth)).toEqual(['Jan Nowak', 'Ewa Dwa Salony']);
  });
});

describe('who paid the most first (task 283)', () => {
  const names = async (query: string, auth = owner.auth) =>
    (await ctx.http().get(`${customersBase}?${query}`).set(auth).expect(200)).body.map(
      (c: { name: string }) => c.name,
    );

  async function client(name: string, phone: string): Promise<string> {
    return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
      .body.id;
  }

  it('paid visits after discounts, the most first; then everyone else by name', async () => {
    // Jan: two paid visits, one with a 20 zł discount — 80 + 60 = 140 zł.
    const first = await pastVisit(kasiaId, 20);
    await ctx.prisma.appointment.update({ where: { id: first }, data: { discountGrosze: 2000 } });
    await pastVisit(kasiaId, 10);
    // Ewa: one paid visit (80 zł) and one that took place but is not paid yet.
    customerId = await client('Ewa Raz', '+48600000003');
    await pastVisit(tomekId, 5);
    await pastVisit(tomekId, 3, false);
    // Olek: three visits that took place, none paid — more visits, but nothing paid.
    customerId = await client('Olek Niezapłacony', '+48600000004');
    for (const days of [30, 25, 15]) await pastVisit(tomekId, days, false);
    // Zosia: a paid visit that was cancelled afterwards does not count.
    customerId = await client('Zosia Odwołana', '+48600000005');
    const cancelled = await pastVisit(kasiaId, 2);
    await ctx.prisma.appointment.update({
      where: { id: cancelled },
      data: { status: 'cancelled', cancelledBy: 'salon' },
    });
    await client('Adam Nikt', '+48600000006');

    expect(await names('sort=paid')).toEqual([
      'Jan Nowak',
      'Ewa Raz',
      'Adam Nikt',
      'Olek Niezapłacony',
      'Zosia Odwołana',
    ]);
    // Pages keep the order.
    expect(await names('sort=paid&limit=2&offset=1')).toEqual(['Ewa Raz', 'Adam Nikt']);
    // The manager sees the money too: the same order for the salon's clients.
    expect(await names('sort=paid', manager.auth)).toEqual([
      'Jan Nowak',
      'Ewa Raz',
      'Olek Niezapłacony',
      'Zosia Odwołana',
    ]);
    // A specialist has no client list (and does not see what clients paid).
    await ctx.http().get(`${customersBase}?sort=paid`).set(kasia.auth).expect(403);
  });

  it('counts only the salons the manager works in, and only the main currency', async () => {
    const other = await ctx.prisma.location.create({
      data: {
        organizationId: orgId,
        name: 'Drugi',
        slug: 'drugi-283',
        addressLine: 'Prosta 1',
        city: 'Warszawa',
        postalCode: '00-001',
      },
    });
    // Jan: 80 zł here. Ewa: 80 zł here and 160 zł in the other salon.
    await pastVisit(kasiaId, 5);
    customerId = await client('Ewa Dwa Salony', '+48600000003');
    await pastVisit(tomekId, 15);
    for (const days of [40, 30]) {
      const id = await pastVisit(tomekId, days);
      await ctx.prisma.appointment.update({ where: { id }, data: { locationId: other.id } });
    }
    // Celina: a big sum, but only in a Prague salon (CZK) — not comparable with złoty.
    const prague = await ctx.prisma.location.create({
      data: {
        organizationId: orgId,
        name: 'Praha',
        slug: 'praha-283',
        addressLine: 'Václavské náměstí 1',
        city: 'Praha',
        postalCode: '110 00',
        currency: 'CZK',
      },
    });
    customerId = await client('Celina Praga', '+48600000004');
    const there = await pastVisit(tomekId, 8);
    await ctx.prisma.appointment.update({
      where: { id: there },
      data: { locationId: prague.id, priceGrosze: 500000 },
    });

    expect(await names('sort=paid')).toEqual(['Ewa Dwa Salony', 'Jan Nowak', 'Celina Praga']);
    // The manager works only in the first salon: 80 zł each there, then by name (Celina has no
    // visit there, so she is not on the manager's list at all).
    expect(await names('sort=paid', manager.auth)).toEqual(['Ewa Dwa Salony', 'Jan Nowak']);
  });
});
