import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

interface Salon {
  owner: SignedInUser;
  locationId: string;
  base: string;
  slug: string;
  serviceId: string;
  staffId: string;
}

let ctx: TestContext;
let first: Salon;
let second: Salon;
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

async function setupSalon(ownerEmail: string, orgName: string): Promise<Salon> {
  const owner = await signUp(ctx, ownerEmail);
  const { orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, orgName);
  const base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
    .expect(201);
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
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
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  return {
    owner,
    locationId,
    base,
    slug,
    serviceId: service.body.id,
    staffId: staff.body.id,
  };
}

function lastCode(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code sent to ${email}`);
  return match[1];
}

/** Books online in `salon` as the client with `email`; returns the confirm response. */
async function bookOnline(salon: Salon, start: string, email = ANNA, signIn?: boolean) {
  const hold = await ctx
    .http()
    .post(`/v1/public/locations/${salon.slug}/holds`)
    .send({ serviceId: salon.serviceId, staffId: salon.staffId, start })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${hold.body.holdId}/code`)
    .send({
      holdToken: hold.body.holdToken,
      name: 'Anna Kowalska',
      phone: '+48600100200',
      email,
      locale: 'pl',
      acceptTerms: true,
    })
    .expect(202);
  return ctx
    .http()
    .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
    .send({
      holdToken: hold.body.holdToken,
      code: lastCode(email),
      ...(signIn === undefined ? {} : { signIn }),
    })
    .expect(200);
}

/** Books online in `salon` as the client with `email`; returns the appointment id. */
async function book(salon: Salon, start: string, email = ANNA): Promise<string> {
  const confirmed = await bookOnline(salon, start, email);
  return confirmed.body.appointment.id as string;
}

const requestCode = (email: string, locale = 'pl') =>
  ctx.http().post('/v1/client/auth/code').send({ email, locale });

const verify = (email: string, code: string, clientType: 'web' | 'mobile' = 'mobile') =>
  ctx.http().post('/v1/client/auth/verify').send({ email, code, clientType });

/** Signs in through the app (mobile) and returns the auth header. */
async function signIn(email: string): Promise<{ Authorization: string }> {
  await requestCode(email).expect(202);
  const res = await verify(email, lastCode(email)).expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  first = await setupSalon('owner1@example.com', 'Barber One');
  second = await setupSalon('owner2@example.com', 'Barber Two');
  day = addDays(localToday(Date.now(), TZ), 3);
});

describe('client app: sign in with an email code', () => {
  it('emails a code in the chosen language and signs in on mobile', async () => {
    await requestCode('Anna.Client@Example.com', 'uk').expect(202);
    const email = ctx.mail.lastTo(ANNA);
    expect(email?.subject).toBe('Код входу до ваших візитів');
    expect(email?.text).toMatch(/Код: \d{6}/);

    const res = await verify(ANNA, lastCode(ANNA)).expect(200);
    expect(res.body.person).toMatchObject({ email: ANNA });
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.headers['set-cookie']).toBeUndefined();

    const me = await ctx
      .http()
      .get('/v1/client/me')
      .set({ Authorization: `Bearer ${res.body.token}` })
      .expect(200);
    expect(me.body.email).toBe(ANNA);
    // Only the hash of the session token is stored.
    const sessions = await ctx.prisma.clientSession.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).not.toBe(res.body.token);
  });

  it('answers the same for an address without visits (no account probing)', async () => {
    const res = await requestCode('nobody@example.com').expect(202);
    expect(res.body.codeExpiresAt).toEqual(expect.any(String));
    expect(ctx.mail.lastTo('nobody@example.com')).toBeDefined();
  });

  it('web: the session is an httpOnly cookie limited to the client API', async () => {
    await requestCode(ANNA).expect(202);
    const res = await verify(ANNA, lastCode(ANNA), 'web').expect(200);
    expect(res.body.token).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^bp_client=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/v1\/client/);
    expect(cookie).toMatch(/SameSite=Strict/);

    const pair = cookie.split(';')[0]!;
    await ctx.http().get('/v1/client/me').set('Cookie', pair).expect(200);
    await ctx.http().post('/v1/client/auth/logout').set('Cookie', pair).expect(204);
    await ctx.http().get('/v1/client/me').set('Cookie', pair).expect(401);
  });

  it('rejects wrong, reused, expired and brute-forced codes', async () => {
    await verify(ANNA, '123456')
      .expect(400)
      .expect((r) => expectError(r.body, 'CODE_NOT_SENT'));

    await requestCode(ANNA).expect(202);
    const code = lastCode(ANNA);
    const wrong = code === '000000' ? '000001' : '000000';
    const res = await verify(ANNA, wrong).expect(400);
    expectError(res.body, 'INVALID_CODE');

    await verify(ANNA, code).expect(200);
    // Single use.
    await verify(ANNA, code)
      .expect(400)
      .expect((r) => expectError(r.body, 'CODE_NOT_SENT'));

    await requestCode(ANNA).expect(202);
    for (let i = 0; i < 5; i++) await verify(ANNA, wrong).expect(400);
    await verify(ANNA, lastCode(ANNA))
      .expect(429)
      .expect((r) => expectError(r.body, 'TOO_MANY_ATTEMPTS'));

    // A new code starts over; an expired one is refused.
    await requestCode(ANNA).expect(202);
    await ctx.prisma.clientLoginCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    await verify(ANNA, lastCode(ANNA))
      .expect(410)
      .expect((r) => expectError(r.body, 'CODE_EXPIRED'));
  });

  it('limits codes per address', async () => {
    for (let i = 0; i < 5; i++) await requestCode(ANNA).expect(202);
    await requestCode(ANNA)
      .expect(429)
      .expect((r) => expectError(r.body, 'RATE_LIMITED'));
  });

  it('needs a client session; a salon access token is not one', async () => {
    await ctx.http().get('/v1/client/appointments').expect(401);
    await ctx.http().get('/v1/client/appointments').set(first.owner.auth).expect(401);
    await ctx
      .http()
      .get('/v1/client/appointments')
      .set({ Authorization: 'Bearer not-a-real-token-at-all-000000' })
      .expect(401);
  });

  it('expired sessions do not work', async () => {
    const auth = await signIn(ANNA);
    await ctx.prisma.clientSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    await ctx.http().get('/v1/client/me').set(auth).expect(401);
  });

  it('changes the language of the client', async () => {
    const auth = await signIn(ANNA);
    const res = await ctx
      .http()
      .patch('/v1/client/me')
      .set(auth)
      .send({ locale: 'ru' })
      .expect(200);
    expect(res.body.locale).toBe('ru');
  });
});

describe('client app: my visits in all salons', () => {
  it('lists upcoming visits from every salon, soonest first, only my own', async () => {
    const later = await book(first, at(day, 15));
    const sooner = await book(second, at(day, 10));
    await book(first, at(day, 11), BOB);
    // An unconfirmed hold is never shown.
    await ctx
      .http()
      .post(`/v1/public/locations/${first.slug}/holds`)
      .send({ serviceId: first.serviceId, staffId: first.staffId, start: at(day, 13) })
      .expect(201);

    const auth = await signIn(ANNA);
    const res = await ctx.http().get('/v1/client/appointments').set(auth).expect(200);
    expect(res.body.items.map((a: { id: string }) => a.id)).toEqual([sooner, later]);
    const item = res.body.items[1];
    expect(item).toMatchObject({
      status: 'confirmed',
      time: '15:00',
      canChange: true,
      service: { name: 'Strzyżenie', priceGrosze: 8000 },
      staff: { displayName: 'Kasia' },
      salon: { slug: first.slug, city: 'Warszawa' },
      bookAgain: { slug: first.slug, serviceId: first.serviceId, staffId: first.staffId },
    });
    // Nothing the salon keeps for itself (the client's own wishes note is theirs to see).
    for (const item of res.body.items) {
      expect(Object.keys(item)).not.toContain('note');
      expect(item.wishes).toEqual({ mood: null, drink: null, note: null });
    }
    expect(JSON.stringify(res.body)).not.toMatch(/tags|phone":"\+48600/);

    const bob = await signIn(BOB);
    const bobs = await ctx.http().get('/v1/client/appointments').set(bob).expect(200);
    expect(bobs.body.items).toHaveLength(1);
  });

  it('includes visits the salon entered with the same email', async () => {
    const created = await ctx
      .http()
      .post(`${first.base}/appointments`)
      .set(first.owner.auth)
      .send({
        serviceId: first.serviceId,
        staffId: first.staffId,
        start: at(day, 12),
        customer: { name: 'Anna Kowalska', phone: '+48600100200', email: ANNA },
      });
    expect(created.status).toBe(201);
    const auth = await signIn(ANNA);
    const res = await ctx.http().get('/v1/client/appointments').set(auth).expect(200);
    expect(res.body.items.map((a: { id: string }) => a.id)).toEqual([created.body.id]);
  });

  it('someone else’s visit looks like a missing one', async () => {
    const bobs = await book(first, at(day, 11), BOB);
    const auth = await signIn(ANNA);
    await ctx.http().get(`/v1/client/appointments/${bobs}`).set(auth).expect(404);
    await ctx.http().post(`/v1/client/appointments/${bobs}/cancel`).set(auth).send({}).expect(404);
    await ctx.http().get('/v1/client/appointments/not-a-uuid').set(auth).expect(404);
  });

  it('cancels until the salon deadline; the visit moves to past', async () => {
    const id = await book(first, at(day, 10));
    const auth = await signIn(ANNA);
    const res = await ctx
      .http()
      .post(`/v1/client/appointments/${id}/cancel`)
      .set(auth)
      .send({ reason: 'Choroba' })
      .expect(200);
    expect(res.body).toMatchObject({ id, status: 'cancelled', canChange: false });

    const upcoming = await ctx.http().get('/v1/client/appointments').set(auth).expect(200);
    expect(upcoming.body.items).toHaveLength(0);
    const past = await ctx
      .http()
      .get('/v1/client/appointments')
      .query({ scope: 'past' })
      .set(auth)
      .expect(200);
    expect(past.body.items.map((a: { id: string }) => a.id)).toEqual([id]);

    const appointment = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });
    expect(appointment).toMatchObject({ cancelledBy: 'customer', cancelReason: 'Choroba' });
    const kinds = (await ctx.prisma.notificationOutbox.findMany()).map((r) => r.type);
    expect(kinds).toEqual(expect.arrayContaining(['client_cancelled', 'salon_client_cancelled']));
  });

  it('refuses changes after the deadline', async () => {
    const id = await book(first, at(day, 10));
    await ctx.prisma.location.update({
      where: { id: first.locationId },
      data: { clientCancelDeadlineMinutes: 10 * 24 * 60 },
    });
    const auth = await signIn(ANNA);
    const detail = await ctx.http().get(`/v1/client/appointments/${id}`).set(auth).expect(200);
    expect(detail.body.canChange).toBe(false);
    await ctx
      .http()
      .post(`/v1/client/appointments/${id}/cancel`)
      .set(auth)
      .send({})
      .expect(409)
      .expect((r) => expectError(r.body, 'TOO_LATE_TO_CHANGE'));
    await ctx
      .http()
      .post(`/v1/client/appointments/${id}/reschedule`)
      .set(auth)
      .send({ start: at(day, 14) })
      .expect(409);
  });

  it('reschedules to another free time', async () => {
    const id = await book(first, at(day, 10));
    const auth = await signIn(ANNA);
    const res = await ctx
      .http()
      .post(`/v1/client/appointments/${id}/reschedule`)
      .set(auth)
      .send({ start: at(day, 14) })
      .expect(200);
    expect(res.body).toMatchObject({ id, time: '14:00', status: 'confirmed' });
    const events = await ctx.prisma.appointmentEvent.findMany({ where: { appointmentId: id } });
    expect(events.map((e) => e.type)).toContain('rescheduled');
  });

  it('the client changes the visit wishes in the app; only on own visits (task 80)', async () => {
    const id = await book(first, at(day, 10));
    const bobsVisit = await book(first, at(day, 12), BOB);
    const auth = await signIn(ANNA);
    const res = await ctx
      .http()
      .put(`/v1/client/appointments/${id}/wishes`)
      .set(auth)
      .send({ mood: 'chat', note: 'Krótko po bokach' })
      .expect(200);
    expect(res.body.wishes).toEqual({ mood: 'chat', drink: null, note: 'Krótko po bokach' });
    expect(res.body.canChangeWishes).toBe(true);
    await ctx
      .http()
      .put(`/v1/client/appointments/${bobsVisit}/wishes`)
      .set(auth)
      .send({ mood: 'quiet' })
      .expect(404);
    await ctx.http().put(`/v1/client/appointments/${id}/wishes`).send({}).expect(401);
  });

  it('"book again" disappears when the salon stops taking the service online', async () => {
    const id = await book(first, at(day, 10));
    await ctx.prisma.service.update({ where: { id: first.serviceId }, data: { active: false } });
    const auth = await signIn(ANNA);
    const res = await ctx.http().get(`/v1/client/appointments/${id}`).set(auth).expect(200);
    expect(res.body.bookAgain).toBeNull();
  });
});

describe('client app: signed in right after booking online', () => {
  it('signIn=true sets the client session cookie; the new visit is already in "My visits"', async () => {
    const res = await bookOnline(first, at(day, 10), ANNA, true);
    expect(res.body.signedIn).toBe(true);
    expect(res.body.manageToken).toEqual(expect.any(String));
    const cookie = String(res.headers['set-cookie']);
    // The session token is never in the body.
    expect(JSON.stringify(res.body)).not.toContain(
      cookie.split(';')[0]!.slice('bp_client='.length),
    );
    expect(cookie).toMatch(/^bp_client=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/v1\/client/);
    expect(cookie).toMatch(/SameSite=Strict/);

    const pair = cookie.split(';')[0]!;
    const me = await ctx.http().get('/v1/client/me').set('Cookie', pair).expect(200);
    expect(me.body).toMatchObject({ email: ANNA, locale: 'pl' });
    const list = await ctx
      .http()
      .get('/v1/client/appointments?scope=upcoming')
      .set('Cookie', pair)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toEqual([res.body.appointment.id]);

    // Only the hash is stored; the session is a web session.
    const sessions = await ctx.prisma.clientSession.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.clientType).toBe('web');
    expect(cookie).not.toContain(sessions[0]!.tokenHash);
  });

  it('without signIn nothing changes: no cookie, no session', async () => {
    const res = await bookOnline(first, at(day, 10));
    expect(res.body.signedIn).toBe(false);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await ctx.prisma.clientSession.count()).toBe(0);
    expect(await ctx.prisma.person.count()).toBe(0);
  });

  it('a later booking with the same email reuses the person; the session sees both salons', async () => {
    await book(second, at(day, 12));
    const res = await bookOnline(first, at(day, 10), ANNA, true);
    const pair = String(res.headers['set-cookie']).split(';')[0]!;
    const list = await ctx
      .http()
      .get('/v1/client/appointments?scope=upcoming')
      .set('Cookie', pair)
      .expect(200);
    expect(list.body.items).toHaveLength(2);
    expect(await ctx.prisma.person.count()).toBe(1);
  });

  it('a retried confirm (same Idempotency-Key) does not create a second session', async () => {
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${first.slug}/holds`)
      .send({ serviceId: first.serviceId, staffId: first.staffId, start: at(day, 10) })
      .expect(201);
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({
        holdToken: hold.body.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100200',
        email: ANNA,
        locale: 'pl',
        acceptTerms: true,
      })
      .expect(202);
    const body = { holdToken: hold.body.holdToken, code: lastCode(ANNA), signIn: true };
    const confirm = () =>
      ctx
        .http()
        .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
        .set('Idempotency-Key', 'confirm-retry-0001')
        .send(body)
        .expect(200);
    const res = await confirm();
    const token = String(res.headers['set-cookie']).split(';')[0]!.slice('bp_client='.length);
    const retry = await confirm();
    expect(retry.body.appointment.id).toBe(res.body.appointment.id);
    expect(await ctx.prisma.clientSession.count()).toBe(1);
    // The stored response has no session token in it.
    const stored = await ctx.prisma.idempotencyKey.findMany();
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('a wrong code signs nobody in', async () => {
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${first.slug}/holds`)
      .send({ serviceId: first.serviceId, staffId: first.staffId, start: at(day, 10) })
      .expect(201);
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({
        holdToken: hold.body.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100200',
        email: ANNA,
        locale: 'pl',
        acceptTerms: true,
      })
      .expect(202);
    const wrong = lastCode(ANNA) === '000000' ? '111111' : '000000';
    const res = await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
      .send({ holdToken: hold.body.holdToken, code: wrong, signIn: true })
      .expect(400);
    expectError(res.body, 'INVALID_CODE');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await ctx.prisma.clientSession.count()).toBe(0);
  });
});
