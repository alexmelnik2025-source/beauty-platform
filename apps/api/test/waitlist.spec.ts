import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import { WaitlistService } from '../src/waitlist/waitlist.service';
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

/** Task 50: "tell me when a time becomes free". */

const TZ = 'Europe/Warsaw';
const ANNA = 'anna.client@example.com';
const BOB = 'bob.client@example.com';

let ctx: TestContext;
let outbox: OutboxService;
let waitlist: WaitlistService;
let owner: SignedInUser;
let slug: string;
let base: string;
let serviceId: string;
let staffId: string;
let orgId: string;
let locationId: string;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(OutboxService);
  waitlist = ctx.app.get(WaitlistService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  slug = org.slug;
  orgId = org.orgId;
  locationId = org.locationId;
  base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  staffId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [serviceId] })
      .expect(201)
  ).body.id;
  // One 45-minute visit fits a day: 09:00–09:45.
  await ctx
    .http()
    .put(`${base}/staff/${staffId}/working-hours`)
    .set(owner.auth)
    .send({
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        intervals: [{ start: '09:00', end: '09:45' }],
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

const dayAhead = (n: number) => addDays(localToday(Date.now(), TZ), n);

/** Books the day's only time for a walk-in client; returns the visit. */
async function fillDay(date: string): Promise<{ id: string; version: number }> {
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId,
      staffId,
      start: new Date(zonedToInstant(date, 9 * 60, TZ)).toISOString(),
      customer: { name: 'Jan Nowak', phone: '+48600000001' },
    })
    .expect(201);
  return res.body;
}

const join = (date: string, email = ANNA, extra: object = {}) =>
  ctx
    .http()
    .post(`/v1/public/locations/${slug}/waitlist`)
    .send({
      serviceId,
      staffId,
      date,
      name: 'Anna Kowalska',
      email,
      locale: 'pl',
      acceptTerms: true,
      ...extra,
    });

async function cancelVisit(visit: { id: string; version: number }): Promise<void> {
  await ctx
    .http()
    .post(`${base}/appointments/${visit.id}/cancel`)
    .set(owner.auth)
    .send({ version: visit.version, reason: 'Choroba' })
    .expect(200);
}

/** Task 164: the token of the offer link in the last email to `email`. */
function offerTokenOf(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\/pl\/wo\/([\w-]+)/);
  if (!match?.[1]) throw new Error(`no offer link sent to ${email}`);
  return match[1];
}

/** The token of the "leave the list" link in the last email to `email`. */
function leaveToken(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\/pl\/w\/([\w-]+)/);
  if (!match?.[1]) throw new Error(`no waiting-list link sent to ${email}`);
  return match[1];
}

describe('waiting list', () => {
  it('a full day: the first client in the queue gets the freed time held and takes it (164)', async () => {
    const day = dayAhead(3);
    const visit = await fillDay(day);

    const joined = await join(day).expect(201);
    expect(joined.body).toEqual({ date: day, status: 'waiting', alreadyWaiting: false });
    await outbox.drain();
    const welcome = ctx.mail.lastTo(ANNA)!;
    expect(welcome.subject).toBe('Jesteś na liście oczekujących');
    expect(welcome.text).toContain('Strzyżenie u Kasia (Barber Centrum)');
    expect(welcome.senderName).toBe('Barber Centrum');
    const token = leaveToken(ANNA);
    const entry = await ctx.http().get(`/v1/public/waitlist/${token}`).expect(200);
    expect(entry.body).toMatchObject({
      salon: { name: 'Barber Centrum', slug },
      serviceName: 'Strzyżenie',
      staffName: 'Kasia',
      date: day,
      status: 'waiting',
    });
    // Asking again does not add a second entry or a second email.
    expect((await join(day).expect(201)).body.alreadyWaiting).toBe(true);
    await outbox.drain();
    expect(ctx.mail.allTo(ANNA)).toHaveLength(1);

    // Nothing is free yet.
    expect(await waitlist.sweep()).toBe(0);

    // Bob asks later: he is second in the queue.
    await join(day, BOB, { phone: '+48600222333' }).expect(201);
    await outbox.drain();

    // The salon cancels the visit: the time is held for Anna (first) for 15 minutes.
    await cancelVisit(visit);
    expect(await waitlist.sweep()).toBe(1);
    await outbox.drain();
    const offer = ctx.mail.lastTo(ANNA)!;
    expect(offer.subject).toBe('Termin czeka na Ciebie: Barber Centrum');
    expect(offer.text).toContain('Strzyżenie u Kasia (Barber Centrum)');
    expect(offer.text).toContain('godz. 09:00');
    expect(offer.text).toContain('przez 15 minut');
    expect(offer.text).toContain('zaproponujemy go następnej osobie');
    expect(ctx.mail.allTo(BOB)).toHaveLength(1);
    const offerToken = offerTokenOf(ANNA);
    // Held: nobody else can book it, so a new client may still wait for that day.
    await join(day, 'carol@example.com').expect(201);
    // One open offer at a time.
    expect(await waitlist.sweep()).toBe(0);

    const shown = await ctx.http().get(`/v1/public/waitlist-offers/${offerToken}`).expect(200);
    expect(shown.body).toMatchObject({
      salon: { name: 'Barber Centrum', slug },
      serviceName: 'Strzyżenie',
      staffName: 'Kasia',
      date: day,
      time: '09:00',
      durationMinutes: 45,
      priceGrosze: 8000,
      status: 'offered',
      needsPhone: true,
    });
    expect(Date.parse(shown.body.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await ctx.http().get(`/v1/public/waitlist/${token}`).expect(200)).body.status).toBe(
      'offered',
    );

    // The list had no phone: one is needed to book.
    expectError(
      (
        await ctx
          .http()
          .post(`/v1/public/waitlist-offers/${offerToken}/accept`)
          .send({})
          .expect(400)
      ).body,
      'PHONE_REQUIRED',
    );
    const taken = await ctx
      .http()
      .post(`/v1/public/waitlist-offers/${offerToken}/accept`)
      .send({ phone: '+48 600 111 222' })
      .expect(200);
    expect(taken.body.status).toBe('booked');
    // Twice is fine; "no" after "yes" changes nothing.
    await ctx.http().post(`/v1/public/waitlist-offers/${offerToken}/accept`).send({}).expect(200);
    const after = await ctx
      .http()
      .post(`/v1/public/waitlist-offers/${offerToken}/decline`)
      .expect(200);
    expect(after.body.status).toBe('booked');

    // A real visit for Anna, with the usual confirmation email (and its manage link).
    const booked = await ctx.prisma.appointment.findMany({
      where: { locationId, status: 'confirmed' },
      include: { customer: true },
    });
    expect(booked).toHaveLength(1);
    expect(booked[0]!.customer).toMatchObject({ email: ANNA, phone: '+48600111222' });
    await outbox.drain();
    expect(ctx.mail.lastTo(ANNA)!.subject).not.toContain('Termin czeka');
    expect(ctx.mail.lastTo(ANNA)!.text).toContain('/pl/m/');
    // Bob was never offered anything; the day is full again.
    expect(await waitlist.sweep()).toBe(0);
    expect(ctx.mail.allTo(BOB)).toHaveLength(1);
    await ctx.http().get('/v1/public/waitlist-offers/not-a-real-token-123456').expect(404);
  });

  it('no answer in 15 minutes or "no": the next client in the queue gets the time (164)', async () => {
    const day = dayAhead(4);
    const visit = await fillDay(day);
    await join(day, ANNA, { phone: '+48600111222' }).expect(201);
    await join(day, BOB, { phone: '+48600222333' }).expect(201);
    await cancelVisit(visit);
    expect(await waitlist.sweep()).toBe(1);
    await outbox.drain();
    const annaOffer = offerTokenOf(ANNA);
    expect(
      (await ctx.http().get(`/v1/public/waitlist-offers/${annaOffer}`).expect(200)).body,
    ).toMatchObject({ status: 'offered', needsPhone: false });

    // 16 minutes later Anna has not answered: the time goes to Bob.
    expect(await waitlist.sweep(Date.now() + 16 * 60_000)).toBe(1);
    await outbox.drain();
    expect(ctx.mail.lastTo(BOB)!.subject).toBe('Termin czeka na Ciebie: Barber Centrum');
    expect(
      (await ctx.http().get(`/v1/public/waitlist-offers/${annaOffer}`).expect(200)).body.status,
    ).toBe('missed');
    expectError(
      (await ctx.http().post(`/v1/public/waitlist-offers/${annaOffer}/accept`).send({}).expect(410))
        .body,
      'OFFER_GONE',
    );

    // Bob says no: the time is free on the booking page for everyone.
    const bobOffer = offerTokenOf(BOB);
    const no = await ctx.http().post(`/v1/public/waitlist-offers/${bobOffer}/decline`).expect(200);
    expect(no.body.status).toBe('declined');
    await ctx.http().post(`/v1/public/waitlist-offers/${bobOffer}/decline`).expect(200);
    expectError(
      (await ctx.http().post(`/v1/public/waitlist-offers/${bobOffer}/accept`).send({}).expect(410))
        .body,
      'OFFER_GONE',
    );
    expect(await waitlist.sweep()).toBe(0);
    expectError((await join(day, 'carol@example.com').expect(409)).body, 'SLOTS_AVAILABLE');
    expect(await ctx.prisma.appointment.count({ where: { locationId, status: 'held' } })).toBe(0);
  });

  it('leaving with an open offer gives the time back; the salon sees who got an offer (164)', async () => {
    const day = dayAhead(5);
    const visit = await fillDay(day);
    await join(day, ANNA).expect(201);
    await outbox.drain();
    await cancelVisit(visit);
    expect(await waitlist.sweep()).toBe(1);
    const list = await ctx.http().get(`${base}/waitlist`).set(owner.auth).expect(200);
    expect(list.body.items[0]).toMatchObject({ email: ANNA, status: 'offered' });
    expect(list.body.items[0].notifiedAt).not.toBeNull();

    const left = await ctx
      .http()
      .post(`/v1/public/waitlist/${leaveToken(ANNA)}/cancel`)
      .expect(200);
    expect(left.body.status).toBe('cancelled');
    expect(await ctx.prisma.appointment.count({ where: { locationId, status: 'held' } })).toBe(0);
    // The offer email (sent after leaving) is not sent any more.
    const before = ctx.mail.allTo(ANNA).length;
    await outbox.drain();
    expect(ctx.mail.allTo(ANNA)).toHaveLength(before);
    expectError((await join(day, BOB).expect(409)).body, 'SLOTS_AVAILABLE');
  });

  it('the client can leave the list; then nothing is sent', async () => {
    const day = dayAhead(2);
    const visit = await fillDay(day);
    await join(day, BOB).expect(201);
    await outbox.drain();
    const token = leaveToken(BOB);
    const left = await ctx.http().post(`/v1/public/waitlist/${token}/cancel`).expect(200);
    expect(left.body.status).toBe('cancelled');
    await ctx.http().post(`/v1/public/waitlist/${token}/cancel`).expect(200);
    await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/cancel`)
      .set(owner.auth)
      .send({ version: visit.version, reason: 'Choroba' })
      .expect(200);
    expect(await waitlist.sweep()).toBe(0);
    await ctx.http().get('/v1/public/waitlist/not-a-real-token-123456').expect(404);
  });

  it('only for full days within the booking horizon; at most 3 days per email', async () => {
    // A day with a free time: book it instead.
    expectError((await join(dayAhead(5)).expect(409)).body, 'SLOTS_AVAILABLE');
    // In the past or beyond the horizon (30 days).
    expectError((await join(dayAhead(-1)).expect(400)).body, 'WAITLIST_DATE');
    expectError((await join(dayAhead(40)).expect(400)).body, 'WAITLIST_DATE');
    // The terms must be accepted; the service must be the salon's.
    await join(dayAhead(5), ANNA, { acceptTerms: false }).expect(400);
    await join(dayAhead(5), ANNA, { serviceId: '0190f0f0-0000-7000-8000-000000000000' }).expect(
      404,
    );

    for (const n of [2, 3, 4, 6]) await fillDay(dayAhead(n));
    await join(dayAhead(2)).expect(201);
    await join(dayAhead(3)).expect(201);
    await join(dayAhead(4)).expect(201);
    expectError((await join(dayAhead(6)).expect(409)).body, 'WAITLIST_LIMIT');
    // Another client may still wait for that day; "any specialist" works too.
    await join(dayAhead(6), BOB, { staffId: undefined }).expect(201);
  });

  it('the salon sees who waits by day with contacts and can remove a client (50c)', async () => {
    const d2 = dayAhead(2);
    const d4 = dayAhead(4);
    await fillDay(d2);
    await fillDay(d4);
    await join(d4, ANNA, { phone: '+48 600 111 222' }).expect(201);
    await join(d2, BOB, { name: 'Bob Brown', staffId: undefined }).expect(201);
    await join(d2, 'carol@example.com', { name: 'Carol' }).expect(201);
    await outbox.drain();
    // Carol leaves from her email: she is not listed any more.
    await ctx
      .http()
      .post(`/v1/public/waitlist/${leaveToken('carol@example.com')}/cancel`)
      .expect(200);

    const list = await ctx.http().get(`${base}/waitlist`).set(owner.auth).expect(200);
    expect(list.body.from).toBe(localToday(Date.now(), TZ));
    expect(list.body.items.map((e: { name: string }) => e.name)).toEqual([
      'Bob Brown',
      'Anna Kowalska',
    ]);
    expect(list.body.items[0]).toMatchObject({
      date: d2,
      serviceName: 'Strzyżenie',
      staffId: null,
      staffName: null,
      email: BOB,
      phone: null,
      status: 'waiting',
      notifiedAt: null,
    });
    expect(list.body.items[1]).toMatchObject({
      date: d4,
      staffName: 'Kasia',
      email: ANNA,
      phone: '+48600111222',
    });
    // From a later day on.
    const later = await ctx.http().get(`${base}/waitlist?from=${d4}`).set(owner.auth).expect(200);
    expect(later.body.items).toHaveLength(1);
    await ctx.http().get(`${base}/waitlist?from=tomorrow`).set(owner.auth).expect(400);

    // Removing: no email, listed no more, twice is fine, the change log has it.
    const bob = list.body.items[0].id as string;
    const sent = ctx.mail.allTo(BOB).length;
    const removed = await ctx
      .http()
      .post(`${base}/waitlist/${bob}/remove`)
      .set(owner.auth)
      .expect(200);
    expect(removed.body.status).toBe('cancelled');
    await ctx.http().post(`${base}/waitlist/${bob}/remove`).set(owner.auth).expect(200);
    await outbox.drain();
    expect(ctx.mail.allTo(BOB)).toHaveLength(sent);
    const after = await ctx.http().get(`${base}/waitlist`).set(owner.auth).expect(200);
    expect(after.body.items.map((e: { name: string }) => e.name)).toEqual(['Anna Kowalska']);
    const log = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/audit-log`)
      .set(owner.auth)
      .expect(200);
    expect(log.body.items[0]).toMatchObject({ action: 'waitlist.removed', entityId: bob });
    // A removed client is not told when a time frees up.
    expect(await waitlist.sweep()).toBe(0);
    await ctx
      .http()
      .post(`${base}/waitlist/0190f0f0-0000-7000-8000-000000000000/remove`)
      .set(owner.auth)
      .expect(404);
  });

  it("owner and the location's manager only; other salons see nothing (50c)", async () => {
    const day = dayAhead(3);
    await fillDay(day);
    await join(day).expect(201);
    const entry = (await ctx.http().get(`${base}/waitlist`).set(owner.auth).expect(200)).body
      .items[0].id as string;

    const manager = await signUp(ctx, 'manager@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: manager.userId,
        organizationId: orgId,
        role: 'manager',
        locations: { create: [{ locationId }] },
      },
    });
    const managed = await ctx.http().get(`${base}/waitlist`).set(manager.auth).expect(200);
    expect(managed.body.items).toHaveLength(1);

    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.http().get(`${base}/waitlist`).set(kasia.auth).expect(403);
    await ctx.http().post(`${base}/waitlist/${entry}/remove`).set(kasia.auth).expect(403);

    // Another salon's owner: their own salon's path with this entry, or this salon's path.
    const other = await signUp(ctx, 'other@example.com');
    const otherOrg = await createOrgWithLocation(ctx, other, 'Inny');
    const otherBase = `/v1/organizations/${otherOrg.orgId}/locations/${otherOrg.locationId}`;
    await ctx.http().post(`${otherBase}/waitlist/${entry}/remove`).set(other.auth).expect(404);
    expect(
      (await ctx.http().get(`${otherBase}/waitlist`).set(other.auth).expect(200)).body.items,
    ).toEqual([]);
    await ctx.http().get(`${base}/waitlist`).set(other.auth).expect(404);
    expect(
      (await ctx.http().get(`${base}/waitlist`).set(owner.auth).expect(200)).body.items,
    ).toHaveLength(1);
  });
});

/** Signs in through the client app (mobile) and returns the auth header. */
async function clientSignIn(email: string): Promise<{ Authorization: string }> {
  await ctx.http().post('/v1/client/auth/code').send({ email, locale: 'pl' }).expect(202);
  const code = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/)?.[1];
  const res = await ctx
    .http()
    .post('/v1/client/auth/verify')
    .send({ email, code, clientType: 'mobile' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

describe('waiting list in the client app (51)', () => {
  it('the client joins with their own email, sees their days and leaves', async () => {
    const d2 = dayAhead(2);
    const d3 = dayAhead(3);
    await fillDay(d2);
    await fillDay(d3);
    const anna = await clientSignIn(ANNA);
    await ctx.http().get('/v1/client/waitlist').expect(401);
    await ctx.http().post(`/v1/client/waitlist/locations/${slug}`).send({}).expect(401);

    const body = { serviceId, staffId, date: d3, name: 'Anna', locale: 'pl', acceptTerms: true };
    const joined = await ctx
      .http()
      .post(`/v1/client/waitlist/locations/${slug}`)
      .set(anna)
      .send(body)
      .expect(201);
    expect(joined.body).toEqual({ date: d3, status: 'waiting', alreadyWaiting: false });
    // An email in the body is not accepted: it is always the signed-in client's.
    await ctx
      .http()
      .post(`/v1/client/waitlist/locations/${slug}`)
      .set(anna)
      .send({ ...body, date: d2, staffId: undefined, email: BOB })
      .expect(400);
    await ctx
      .http()
      .post(`/v1/client/waitlist/locations/${slug}`)
      .set(anna)
      .send({ ...body, date: d2, staffId: undefined })
      .expect(201);
    // Same rules as the booking page.
    expectError(
      (
        await ctx
          .http()
          .post(`/v1/client/waitlist/locations/${slug}`)
          .set(anna)
          .send({ ...body, date: dayAhead(5) })
          .expect(409)
      ).body,
      'SLOTS_AVAILABLE',
    );
    await outbox.drain();
    expect(ctx.mail.lastTo(ANNA)?.subject).toBe('Jesteś na liście oczekujących');
    // Bob (booking page) is not shown to Anna.
    await join(d3, BOB).expect(201);

    const list = await ctx.http().get('/v1/client/waitlist').set(anna).expect(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({
      salon: { name: 'Barber Centrum', slug, timezone: TZ },
      serviceName: 'Strzyżenie',
      staffId: null,
      staffName: null,
      date: d2,
      status: 'waiting',
      notifiedAt: null,
    });
    expect(list.body.items[1]).toMatchObject({ date: d3, staffName: 'Kasia' });
    expect(JSON.stringify(list.body)).not.toContain(BOB);

    // Leaving: twice is fine; not listed any more; another client gets 404.
    const id = list.body.items[0].id as string;
    const left = await ctx.http().post(`/v1/client/waitlist/${id}/cancel`).set(anna).expect(200);
    expect(left.body.status).toBe('cancelled');
    await ctx.http().post(`/v1/client/waitlist/${id}/cancel`).set(anna).expect(200);
    const bob = await clientSignIn(BOB);
    await ctx.http().post(`/v1/client/waitlist/${id}/cancel`).set(bob).expect(404);
    await ctx.http().post('/v1/client/waitlist/not-an-id/cancel').set(bob).expect(404);
    const after = await ctx.http().get('/v1/client/waitlist').set(anna).expect(200);
    expect(after.body.items.map((e: { date: string }) => e.date)).toEqual([d3]);
    const bobs = await ctx.http().get('/v1/client/waitlist').set(bob).expect(200);
    expect(bobs.body.items).toHaveLength(1);
  });
});
