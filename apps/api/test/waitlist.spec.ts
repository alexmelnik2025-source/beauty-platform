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

/** The token of the "leave the list" link in the last email to `email`. */
function leaveToken(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\/pl\/w\/([\w-]+)/);
  if (!match?.[1]) throw new Error(`no waiting-list link sent to ${email}`);
  return match[1];
}

describe('waiting list', () => {
  it('a full day: the client waits and hears once when a time becomes free', async () => {
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

    // The salon cancels the visit: the time is free, the client gets one email.
    await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/cancel`)
      .set(owner.auth)
      .send({ version: visit.version, reason: 'Choroba' })
      .expect(200);
    expect(await waitlist.sweep()).toBe(1);
    await outbox.drain();
    const free = ctx.mail.lastTo(ANNA)!;
    expect(free.subject).toBe('Zwolnił się termin: Barber Centrum');
    expect(free.text).toContain('Wolne godziny: 09:00');
    expect(free.text).toContain(`/pl/b/${slug}?service=${serviceId}&staff=${staffId}`);
    expect((await ctx.http().get(`/v1/public/waitlist/${token}`).expect(200)).body.status).toBe(
      'notified',
    );
    // Only once.
    expect(await waitlist.sweep()).toBe(0);
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
});
