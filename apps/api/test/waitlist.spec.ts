import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
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

const TZ = 'Europe/Warsaw';
const ANNA = 'anna.client@example.com';
const BOB = 'bob.client@example.com';
const CAROL = 'carol.client@example.com';

interface Salon {
  owner: SignedInUser;
  base: string;
  slug: string;
  serviceId: string;
  kasia: string;
  ola: string;
}

let ctx: TestContext;
let outbox: OutboxService;
let salon: Salon;
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

async function setupSalon(): Promise<Salon> {
  const owner = await signUp(ctx, 'owner@example.com');
  const { orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Barber One');
  const base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
    .expect(201);
  const staff: string[] = [];
  for (const displayName of ['Kasia', 'Ola']) {
    const created = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName, serviceIds: [service.body.id] })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${created.body.id}/working-hours`)
      .set(owner.auth)
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      })
      .expect(200);
    staff.push(created.body.id);
  }
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  return {
    owner,
    base,
    slug,
    serviceId: service.body.id,
    kasia: staff[0]!,
    ola: staff[1]!,
  };
}

function lastCode(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code sent to ${email}`);
  return match[1];
}

/** Books online as `email` with `staffId`; returns the appointment id. */
async function book(start: string, staffId: string, email = CAROL): Promise<string> {
  const hold = await ctx
    .http()
    .post(`/v1/public/locations/${salon.slug}/holds`)
    .send({ serviceId: salon.serviceId, staffId, start })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${hold.body.holdId}/code`)
    .send({
      holdToken: hold.body.holdToken,
      name: 'Carol',
      phone: '+48600100200',
      email,
      locale: 'pl',
      acceptTerms: true,
    })
    .expect(202);
  const confirmed = await ctx
    .http()
    .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
    .send({ holdToken: hold.body.holdToken, code: lastCode(email) })
    .expect(200);
  return confirmed.body.appointment.id as string;
}

async function signIn(email: string, locale = 'pl'): Promise<{ Authorization: string }> {
  await ctx.http().post('/v1/client/auth/code').send({ email, locale }).expect(202);
  const res = await ctx
    .http()
    .post('/v1/client/auth/verify')
    .send({ email, code: lastCode(email), clientType: 'mobile' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

const join = (auth: { Authorization: string }, body: Record<string, unknown>) =>
  ctx
    .http()
    .post('/v1/client/waitlist')
    .set(auth)
    .send({ slug: salon.slug, serviceId: salon.serviceId, date: day, ...body });

const waitlistEmails = (email: string) =>
  ctx.mail.allTo(email).filter((m) => m.subject.startsWith('Zwolnił się termin'));

async function cancelAsClient(id: string, email = CAROL): Promise<void> {
  const auth = await signIn(email);
  await ctx.http().post(`/v1/client/appointments/${id}/cancel`).set(auth).send({}).expect(200);
}

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(OutboxService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  salon = await setupSalon();
  day = addDays(localToday(Date.now(), TZ), 3);
});

describe('waiting list: joining', () => {
  it('needs a client session', async () => {
    await ctx.http().get('/v1/client/waitlist').expect(401);
    await ctx.http().post('/v1/client/waitlist').send({}).expect(401);
    await ctx.http().get('/v1/client/waitlist').set(salon.owner.auth).expect(401);
  });

  it('joins a day, lists it, joins again without a second entry and leaves', async () => {
    const anna = await signIn(ANNA);
    const joined = await join(anna, { staffId: salon.kasia }).expect(201);
    expect(joined.body).toEqual({
      id: expect.any(String),
      date: day,
      salon: { slug: salon.slug, name: expect.any(String) },
      service: { id: salon.serviceId, name: 'Strzyżenie' },
      staff: { id: salon.kasia, displayName: 'Kasia' },
      notifiedAt: null,
    });
    const again = await join(anna, { staffId: salon.kasia }).expect(201);
    expect(again.body.id).toBe(joined.body.id);
    // Any specialist is another entry.
    const any = await join(anna, {}).expect(201);
    expect(any.body.staff).toBeNull();

    const list = await ctx.http().get('/v1/client/waitlist').set(anna).expect(200);
    expect(list.body.items.map((e: { id: string }) => e.id).sort()).toEqual(
      [joined.body.id, any.body.id].sort(),
    );

    // Bob cannot see or remove Anna's entries.
    const bob = await signIn(BOB);
    expect((await ctx.http().get('/v1/client/waitlist').set(bob).expect(200)).body.items).toEqual(
      [],
    );
    expectError(
      (await ctx.http().delete(`/v1/client/waitlist/${joined.body.id}`).set(bob).expect(404)).body,
      'NOT_FOUND',
    );
    await ctx.http().delete(`/v1/client/waitlist/${joined.body.id}`).set(anna).expect(204);
    await ctx.http().delete(`/v1/client/waitlist/${joined.body.id}`).set(anna).expect(404);
    await ctx.http().delete('/v1/client/waitlist/not-a-uuid').set(anna).expect(404);
    expect(
      (await ctx.http().get('/v1/client/waitlist').set(anna).expect(200)).body.items,
    ).toHaveLength(1);
  });

  it('only days from today to the booking horizon, a bookable service and its specialist', async () => {
    const anna = await signIn(ANNA);
    const today = localToday(Date.now(), TZ);
    expectError(
      (await join(anna, { date: addDays(today, -1) }).expect(400)).body,
      'DATE_OUT_OF_RANGE',
    );
    expectError(
      (await join(anna, { date: addDays(today, 31) }).expect(400)).body,
      'DATE_OUT_OF_RANGE',
    );
    await join(anna, { date: today }).expect(201);
    await join(anna, { date: '2026-02-30' }).expect(400);
    expectError(
      (await join(anna, { serviceId: '00000000-0000-7000-8000-000000000000' }).expect(404)).body,
      'NOT_FOUND',
    );
    expectError(
      (await join(anna, { staffId: '00000000-0000-7000-8000-000000000000' }).expect(404)).body,
      'NOT_FOUND',
    );
    expectError((await join(anna, { slug: 'no-such-salon' }).expect(404)).body, 'NOT_FOUND');
  });

  it('at most 10 days at once', async () => {
    const anna = await signIn(ANNA);
    const today = localToday(Date.now(), TZ);
    for (let i = 0; i < 10; i += 1) {
      await join(anna, { date: addDays(today, i) }).expect(201);
    }
    expectError(
      (await join(anna, { date: addDays(today, 10) }).expect(409)).body,
      'TOO_MANY_WAITLIST',
    );
    // The same day again is not a new one.
    await join(anna, { date: today }).expect(201);
  });
});

describe('waiting list: a time frees up', () => {
  it('a client cancels: the waiting client gets one email with free times and a link', async () => {
    const id = await book(at(day, 10), salon.kasia);
    const anna = await signIn(ANNA);
    await join(anna, { staffId: salon.kasia }).expect(201);
    await outbox.drain();
    ctx.mail.clear();

    await cancelAsClient(id);
    await outbox.drain();
    const emails = waitlistEmails(ANNA);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toMatch(/Barber|— /);
    expect(emails[0]!.text).toContain('Strzyżenie');
    expect(emails[0]!.text).toContain('u Kasia');
    expect(emails[0]!.text).toMatch(/Wolne godziny: \d\d:\d\d/);
    expect(emails[0]!.text).toContain(
      `/pl/b/${salon.slug}?service=${salon.serviceId}&staff=${salon.kasia}`,
    );
    // Nobody else's data in the email (not the client who cancelled).
    expect(emails[0]!.text).not.toContain('Carol');
    expect(emails[0]!.text).not.toContain(CAROL);

    const list = await ctx.http().get('/v1/client/waitlist').set(anna).expect(200);
    expect(list.body.items[0].notifiedAt).not.toBeNull();

    // Another cancellation the same day: no second email until Anna joins again.
    const second = await book(at(day, 12), salon.kasia);
    await cancelAsClient(second);
    await outbox.drain();
    expect(waitlistEmails(ANNA)).toHaveLength(1);
    const rejoined = await join(anna, { staffId: salon.kasia }).expect(201);
    expect(rejoined.body.notifiedAt).toBeNull();
    const third = await book(at(day, 14), salon.kasia);
    await cancelAsClient(third);
    await outbox.drain();
    expect(waitlistEmails(ANNA)).toHaveLength(2);
  });

  it('only the waiting list of that day and specialist; "any specialist" always fits', async () => {
    const id = await book(at(day, 10), salon.kasia);
    const anna = await signIn(ANNA);
    const bob = await signIn(BOB);
    await join(anna, { staffId: salon.ola }).expect(201); // another specialist
    await join(bob, {}).expect(201); // anyone
    const otherDay = await signIn('dan.client@example.com');
    await join(otherDay, { date: addDays(day, 1) }).expect(201);
    await outbox.drain();
    ctx.mail.clear();

    await cancelAsClient(id);
    await outbox.drain();
    expect(waitlistEmails(ANNA)).toHaveLength(0);
    expect(waitlistEmails(BOB)).toHaveLength(1);
    expect(waitlistEmails(BOB)[0]!.text).not.toContain(' u ');
    expect(waitlistEmails('dan.client@example.com')).toHaveLength(0);
  });

  it('the salon cancels or moves a visit away: the time is free for the waiting list', async () => {
    const id = await book(at(day, 10), salon.kasia);
    const anna = await signIn(ANNA);
    await join(anna, {}).expect(201);
    await outbox.drain();
    ctx.mail.clear();

    // Moved to another day by the salon.
    const visit = await ctx
      .http()
      .get(`${salon.base}/appointments/${id}`)
      .set(salon.owner.auth)
      .expect(200);
    await ctx
      .http()
      .post(`${salon.base}/appointments/${id}/reschedule`)
      .set(salon.owner.auth)
      .send({ version: visit.body.version, start: at(addDays(day, 1), 10) })
      .expect(200);
    await outbox.drain();
    expect(waitlistEmails(ANNA)).toHaveLength(1);

    // Cancelled by the salon (Anna joins again first).
    await join(anna, { date: addDays(day, 1) }).expect(201);
    const moved = await ctx
      .http()
      .get(`${salon.base}/appointments/${id}`)
      .set(salon.owner.auth)
      .expect(200);
    await ctx
      .http()
      .post(`${salon.base}/appointments/${id}/cancel`)
      .set(salon.owner.auth)
      .send({ version: moved.body.version, reason: 'Choroba' })
      .expect(200);
    await outbox.drain();
    expect(waitlistEmails(ANNA)).toHaveLength(2);
  });

  it('no one waiting: nothing is queued', async () => {
    const id = await book(at(day, 10), salon.kasia);
    await cancelAsClient(id);
    const queued = await ctx.prisma.notificationOutbox.count({
      where: { type: 'waitlist_time_freed' },
    });
    expect(queued).toBe(0);
  });

  it('a failed send is retried with the same email; the client language is kept', async () => {
    const id = await book(at(day, 10), salon.kasia);
    const anna = await signIn(ANNA, 'uk');
    await ctx.http().patch('/v1/client/me').set(anna).send({ locale: 'uk' }).expect(200);
    await join(anna, {}).expect(201);
    await outbox.drain();
    ctx.mail.clear();

    await cancelAsClient(id);
    // Every email of this cycle fails (the client's, the salon's and the waiting list's).
    ctx.mail.failNext(10);
    await outbox.drain();
    expect(ctx.mail.allTo(ANNA)).toHaveLength(0);
    ctx.mail.failNext(0);
    await ctx.prisma.notificationOutbox.updateMany({
      where: { status: 'pending' },
      data: { nextAttemptAt: new Date(0), lockedUntil: null },
    });
    await outbox.drain();
    const emails = ctx.mail.allTo(ANNA);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toMatch(/^Звільнився час/);
    expect(emails[0]!.text).toContain('/uk/b/');
  });
});
