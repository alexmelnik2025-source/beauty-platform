import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timesFor } from '../src/booking/appointment-writer';
import { OutboxService, SimulatedCrash } from '../src/booking/outbox.service';
import { RateLimiterService } from '../src/common/rate-limiter.service';
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

const TZ = 'Europe/Warsaw';
const CLIENT = {
  name: 'Anna Kowalska',
  phone: '+48 600 100 200',
  email: 'anna.client@example.com',
  locale: 'pl',
  acceptTerms: true,
};

let ctx: TestContext;
let outbox: OutboxService;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let serviceId: string;
let staffIds: string[];
/** A day 3 days ahead: inside the 30-day horizon, beyond the 1-hour lead time. */
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(OutboxService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  ({ orgId, locationId, slug } = org);
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
    .expect(201);
  serviceId = service.body.id;
  staffIds = [];
  for (const name of ['Kasia', 'Ola', 'Piotr']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [serviceId] })
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
    staffIds.push(staff.body.id);
  }
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

// ── Helpers ───────────────────────────────────────────

const hold = (start: string, staffId?: string, extra: Record<string, unknown> = {}) =>
  ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, start, ...(staffId ? { staffId } : {}), ...extra });

const sendCode = (holdId: string, holdToken: string, client = CLIENT) =>
  ctx
    .http()
    .post(`/v1/public/holds/${holdId}/code`)
    .send({ holdToken, ...client });

function lastCode(email = CLIENT.email): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code sent to ${email}`);
  return match[1];
}

const confirm = (holdId: string, holdToken: string, code: string) =>
  ctx.http().post(`/v1/public/holds/${holdId}/confirm`).send({ holdToken, code });

async function book(start: string, staffId = staffIds[0]) {
  const h = await hold(start, staffId).expect(201);
  await sendCode(h.body.holdId, h.body.holdToken).expect(202);
  const c = await confirm(h.body.holdId, h.body.holdToken, lastCode()).expect(200);
  return { holdId: h.body.holdId as string, manageToken: c.body.manageToken as string };
}

const publicTimes = async (staffId = staffIds[0]) =>
  (
    await ctx
      .http()
      .get(`/v1/public/locations/${slug}/availability`)
      .query({ serviceId, staffId, from: day, to: day })
      .expect(200)
  ).body.slots.map((s: { time: string }) => s.time) as string[];

/** Makes everything in the email queue due now (instead of waiting for back-off or reminders). */
const makeQueueDue = () =>
  ctx.prisma
    .$executeRaw`UPDATE notification_outbox SET next_attempt_at = now(), locked_until = NULL WHERE status = 'pending'`;

// ── Booking flow ──────────────────────────────────────

describe('online booking: hold → code → confirm', () => {
  it('books a slot end to end and notifies client and salon', async () => {
    const h = await hold(at(day, 10), staffIds[0]).expect(201);
    expect(h.body).toMatchObject({ time: '10:00', staffName: 'Kasia', priceGrosze: 8000 });
    // The held slot (and its buffer) is no longer offered.
    expect(await publicTimes()).not.toContain('10:00');

    const code = await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    expect(Date.parse(code.body.codeExpiresAt)).toBeLessThanOrEqual(Date.parse(h.body.expiresAt));
    const done = await confirm(h.body.holdId, h.body.holdToken, lastCode()).expect(200);
    expect(done.body.appointment).toMatchObject({ status: 'confirmed', time: '10:00' });

    const appointment = await ctx.prisma.appointment.findUniqueOrThrow({
      where: { id: h.body.holdId },
      include: { customer: { include: { consents: true } }, events: true },
    });
    expect(appointment.customer).toMatchObject({ email: CLIENT.email, phone: '+48600100200' });
    // Only the booking terms; marketing consent was not given.
    expect(appointment.customer!.consents.map((c) => c.type)).toEqual(['booking_terms']);
    expect(appointment.holdContact).toBeNull();
    expect(appointment.events.map((e) => e.type)).toEqual(['confirmed']);

    // The email queue: confirmation + salon now, reminder 24 h before the visit.
    await outbox.drain();
    const toClient = ctx.mail.allTo(CLIENT.email).map((m) => m.subject);
    expect(toClient).toEqual(
      expect.arrayContaining([expect.stringContaining('Wizyta potwierdzona')]),
    );
    expect(ctx.mail.lastTo('owner@example.com')?.subject).toContain('Nowa rezerwacja online');
    const link = ctx.mail.lastTo(CLIENT.email)!.text.match(/\/pl\/m\/(\S+)/)![1]!;
    await ctx.http().get(`/v1/public/appointments/${link}`).expect(200);
    const reminder = await ctx.prisma.notificationOutbox.findFirstOrThrow({
      where: { type: 'client_reminder' },
    });
    expect(reminder.status).toBe('pending');
    expect(reminder.nextAttemptAt.getTime()).toBe(Date.parse(at(day, 10)) - 24 * 3600_000);

    // The salon sees it in the calendar.
    const calendar = await ctx
      .http()
      .get(`${base}/appointments`)
      .query({ from: day, to: day })
      .set(owner.auth)
      .expect(200);
    expect(calendar.body).toHaveLength(1);
    expect(calendar.body[0]).toMatchObject({ status: 'confirmed', source: 'online' });
  });

  it('refuses a time that is not offered (outside hours, off the slot grid, too soon)', async () => {
    expectError((await hold(at(day, 7)).expect(409)).body, 'SLOT_TAKEN');
    expectError((await hold(at(day, 10, 7)).expect(409)).body, 'SLOT_TAKEN');
    // Within the 1-hour minimum lead time.
    const soon = new Date(Math.ceil((Date.now() + 10 * 60_000) / 900_000) * 900_000).toISOString();
    expectError((await hold(soon).expect(409)).body, 'SLOT_TAKEN');
  });

  it('a wrong code counts attempts; the 6th try is refused even with the right code', async () => {
    const h = await hold(at(day, 11)).expect(201);
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    const right = lastCode();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      expectError(
        (await confirm(h.body.holdId, h.body.holdToken, wrong).expect(400)).body,
        'INVALID_CODE',
      );
    }
    expectError(
      (await confirm(h.body.holdId, h.body.holdToken, right).expect(429)).body,
      'TOO_MANY_ATTEMPTS',
    );
  });

  it('a new code replaces the old one; at most 3 codes per hold', async () => {
    const h = await hold(at(day, 12)).expect(201);
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    const first = lastCode();
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    const second = lastCode();
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    expectError(
      (await sendCode(h.body.holdId, h.body.holdToken).expect(429)).body,
      'TOO_MANY_CODES',
    );
    if (first !== lastCode()) {
      expectError(
        (await confirm(h.body.holdId, h.body.holdToken, first).expect(400)).body,
        'INVALID_CODE',
      );
    }
    expect(second).toMatch(/^\d{6}$/);
    await confirm(h.body.holdId, h.body.holdToken, lastCode()).expect(200);
  });

  it('requires accepting the booking terms; marketing consent is stored only when ticked', async () => {
    const h = await hold(at(day, 13)).expect(201);
    await sendCode(h.body.holdId, h.body.holdToken, {
      ...CLIENT,
      acceptTerms: false as true,
    }).expect(400);
    await ctx
      .http()
      .post(`/v1/public/holds/${h.body.holdId}/code`)
      .send({ holdToken: h.body.holdToken, ...CLIENT, marketingConsent: true })
      .expect(202);
    await confirm(h.body.holdId, h.body.holdToken, lastCode()).expect(200);
    const consents = await ctx.prisma.consentRecord.findMany();
    expect(consents.map((c) => c.type).sort()).toEqual(['booking_terms', 'marketing']);
  });

  it('idempotency: a retried request with the same key returns the same hold', async () => {
    const send = (body: object) =>
      ctx
        .http()
        .post(`/v1/public/locations/${slug}/holds`)
        .set('Idempotency-Key', 'mobile-retry-key-1')
        .send(body);
    const body = { serviceId, staffId: staffIds[0], start: at(day, 14) };
    const first = await send(body).expect(201);
    const retry = await send(body).expect(201);
    expect(retry.body.holdId).toBe(first.body.holdId);
    expect(await ctx.prisma.appointment.count()).toBe(1);
    expectError(
      (await send({ ...body, start: at(day, 15) }).expect(422)).body,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });
});

// ── Concurrency (spec: 20 simultaneous requests) ──────

describe('no double booking under concurrency', () => {
  beforeEach(() => {
    ctx.app.get(RateLimiterService).enabled = false;
  });

  it('20 simultaneous holds on one slot of one staff member → exactly 1 succeeds', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => hold(at(day, 10), staffIds[0])),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    for (const r of results.filter((x) => x.status === 409)) expectError(r.body, 'SLOT_TAKEN');
    expect(await ctx.prisma.appointment.count({ where: { status: 'held' } })).toBe(1);
  });

  it('20 simultaneous "any staff member" holds with 3 staff free → exactly 3, all different', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => hold(at(day, 10))));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(3);
    expect(new Set(ok.map((r) => r.body.staffId)).size).toBe(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(17);
  });

  it('two simultaneous moves to the same time → one succeeds, the other gets 409', async () => {
    const create = (hh: number) =>
      ctx
        .http()
        .post(`${base}/appointments`)
        .set(owner.auth)
        .send({
          serviceId,
          staffId: staffIds[0],
          start: at(day, hh),
          customer: { name: 'Jan', phone: '+48600000001' },
        })
        .expect(201);
    const a = await create(10);
    const b = await create(12);
    const move = (id: string) =>
      ctx
        .http()
        .post(`${base}/appointments/${id}/reschedule`)
        .set(owner.auth)
        .send({ version: 1, start: at(day, 15) });
    const results = await Promise.all([move(a.body.id), move(b.body.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

// ── Expiry ────────────────────────────────────────────

describe('expiry of holds and codes', () => {
  const expireHold = (id: string) =>
    ctx.prisma
      .$executeRaw`UPDATE appointment SET hold_expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`;

  it('confirming after 10 minutes is refused and the slot is free again', async () => {
    const h = await hold(at(day, 10)).expect(201);
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    await expireHold(h.body.holdId);
    expectError(
      (await confirm(h.body.holdId, h.body.holdToken, lastCode()).expect(410)).body,
      'HOLD_EXPIRED',
    );
    expect(await publicTimes()).toContain('10:00');
  });

  it('with the background job stopped, an expired hold does not block another client', async () => {
    const first = await hold(at(day, 10), staffIds[0]).expect(201);
    await expireHold(first.body.holdId);
    // No cleanup job runs in tests: the row is still "held" in the database.
    const second = await hold(at(day, 10), staffIds[0]).expect(201);
    expect(second.body.holdId).not.toBe(first.body.holdId);
    const old = await ctx.prisma.appointment.findUniqueOrThrow({
      where: { id: first.body.holdId },
    });
    expect(old.status).toBe('expired');
  });

  it('a code sent near the end of the hold expires together with the hold', async () => {
    const h = await hold(at(day, 10)).expect(201);
    await ctx.prisma
      .$executeRaw`UPDATE appointment SET hold_expires_at = now() + interval '60 seconds' WHERE id = ${h.body.holdId}::uuid`;
    const res = await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    const holdRow = await ctx.prisma.appointment.findUniqueOrThrow({
      where: { id: h.body.holdId },
    });
    expect(Date.parse(res.body.codeExpiresAt)).toBeLessThanOrEqual(
      holdRow.holdExpiresAt!.getTime(),
    );
  });

  it('an expired code is refused', async () => {
    const h = await hold(at(day, 10)).expect(201);
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    await ctx.prisma.verificationCode.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expectError(
      (await confirm(h.body.holdId, h.body.holdToken, lastCode()).expect(410)).body,
      'CODE_EXPIRED',
    );
  });

  it('the cleanup job marks expired holds and later erases their contact details', async () => {
    const h = await hold(at(day, 10)).expect(201);
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    await expireHold(h.body.holdId);
    expect(await outbox.expireHolds()).toBe(1);
    await ctx.prisma
      .$executeRaw`UPDATE appointment SET updated_at = now() - interval '25 hours' WHERE id = ${h.body.holdId}::uuid`;
    await outbox.expireHolds();
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: h.body.holdId } });
    expect(row).toMatchObject({ status: 'expired', holdContact: null });
  });

  it('too many holds from one address → 429', async () => {
    for (let i = 0; i < 5; i += 1) await hold(at(day, 10 + i)).expect(201);
    expectError((await hold(at(day, 16)).expect(429)).body, 'RATE_LIMITED');
  });
});

// ── Email queue ───────────────────────────────────────

describe('email queue (outbox)', () => {
  it('retries after provider errors and sends exactly once', async () => {
    await book(at(day, 10));
    ctx.mail.clear();
    ctx.mail.failNext(2);
    await outbox.drain();
    await makeQueueDue();
    await outbox.drain();
    await makeQueueDue();
    await outbox.drain();
    const confirmations = ctx.mail
      .allTo(CLIENT.email)
      .filter((m) => m.subject.includes('potwierdzona'));
    expect(confirmations).toHaveLength(1);
    const row = await ctx.prisma.notificationOutbox.findFirstOrThrow({
      where: { type: 'client_confirmation' },
    });
    expect(row.status).toBe('sent');
    expect(row.attempts).toBeGreaterThanOrEqual(2);
  });

  it('after a crash between sending and marking, the retry does not send a duplicate', async () => {
    await book(at(day, 10));
    ctx.mail.clear();
    await expect(
      outbox.drain({
        afterSend: () => {
          throw new SimulatedCrash('process died');
        },
      }),
    ).rejects.toThrow('process died');
    // The claimed row stays locked; once the lock runs out another worker takes it.
    await makeQueueDue();
    await outbox.drain();
    expect(
      ctx.mail.allTo(CLIENT.email).filter((m) => m.subject.includes('potwierdzona')),
    ).toHaveLength(1);
  });

  it('jobs survive a worker restart: they wait in PostgreSQL until processed', async () => {
    await book(at(day, 10));
    const pending = await ctx.prisma.notificationOutbox.count({ where: { status: 'pending' } });
    expect(pending).toBeGreaterThanOrEqual(3);
    // A "new" worker (same table, nothing kept in memory) processes them.
    await outbox.drain();
    expect(ctx.mail.lastTo('owner@example.com')).toBeDefined();
  });

  it('a rolled-back change leaves no email in the queue', async () => {
    const h = await hold(at(day, 10)).expect(201);
    await sendCode(h.body.holdId, h.body.holdToken).expect(202);
    await ctx.prisma
      .$executeRaw`UPDATE appointment SET hold_expires_at = now() - interval '1 second' WHERE id = ${h.body.holdId}::uuid`;
    await confirm(h.body.holdId, h.body.holdToken, lastCode()).expect(410);
    expect(await ctx.prisma.notificationOutbox.count()).toBe(0);
  });
});

// ── Client changes via the email link ─────────────────

describe('client manages the appointment via the link', () => {
  it('moves it to another free time: same appointment, old time freed, stale reminder skipped', async () => {
    const { holdId, manageToken } = await book(at(day, 10));
    const res = await ctx
      .http()
      .post(`/v1/public/appointments/${manageToken}/reschedule`)
      .send({ start: at(day, 14) })
      .expect(200);
    expect(res.body).toMatchObject({ id: holdId, time: '14:00', staff: { displayName: 'Kasia' } });
    expect(await publicTimes()).toContain('10:00');
    expect(await publicTimes()).not.toContain('14:00');

    await makeQueueDue();
    await outbox.drain();
    const reminders = await ctx.prisma.notificationOutbox.findMany({
      where: { type: 'client_reminder' },
      orderBy: { createdAt: 'asc' },
    });
    // The reminder for the old time is skipped; the one for the new time is sent.
    expect(reminders.map((r) => r.status)).toEqual(['skipped', 'sent']);
    const history = await ctx
      .http()
      .get(`${base}/appointments/${holdId}`)
      .set(owner.auth)
      .expect(200);
    expect(history.body.history.map((e: { type: string }) => e.type)).toEqual([
      'confirmed',
      'rescheduled',
    ]);
  });

  it('cancels; the slot is free and both sides are told', async () => {
    const { manageToken } = await book(at(day, 10));
    const res = await ctx
      .http()
      .post(`/v1/public/appointments/${manageToken}/cancel`)
      .send({ reason: 'Choroba' })
      .expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(await publicTimes()).toContain('10:00');
    await outbox.drain();
    expect(ctx.mail.lastTo('owner@example.com')?.subject).toContain('Klient odwołał');
  });

  it('cannot change it online after the salon’s deadline', async () => {
    const { manageToken } = await book(at(day, 10));
    // Move the visit to start in 1 hour (deadline is 2 hours).
    await ctx.prisma.appointment.updateMany({
      data: {
        startAt: new Date(Date.now() + 3600_000),
        endAt: new Date(Date.now() + 2 * 3600_000),
      },
    });
    expectError(
      (await ctx.http().post(`/v1/public/appointments/${manageToken}/cancel`).send({}).expect(409))
        .body,
      'TOO_LATE_TO_CHANGE',
    );
  });

  it('an unknown link → 404', async () => {
    await ctx.http().get('/v1/public/appointments/not-a-real-token-123456789').expect(404);
  });
});

// ── Salon side ────────────────────────────────────────

describe('appointments in the salon', () => {
  const manual = (extra: Record<string, unknown> = {}, auth = owner.auth) =>
    ctx
      .http()
      .post(`${base}/appointments`)
      .set(auth)
      .send({
        serviceId,
        staffId: staffIds[0],
        start: at(day, 10),
        customer: { name: 'Jan Nowak', phone: '+48600000002' },
        ...extra,
      });

  it('books by phone; outside hours only with explicit permission; never over another booking', async () => {
    const created = await manual().expect(201);
    expect(created.body).toMatchObject({ status: 'confirmed', source: 'manual', time: '10:00' });

    expectError((await manual({ start: at(day, 20) }).expect(409)).body, 'OUTSIDE_WORKING_HOURS');
    await manual({ start: at(day, 20), allowOutsideHours: true }).expect(201);

    expectError((await manual({ start: at(day, 10, 30) }).expect(409)).body, 'SLOT_TAKEN');
    expectError(
      (await manual({ start: at(day, 10, 30), allowOutsideHours: true }).expect(409)).body,
      'SLOT_TAKEN',
    );
  });

  it('stale version → 409; status only after the start', async () => {
    const a = await manual().expect(201);
    await ctx
      .http()
      .post(`${base}/appointments/${a.body.id}/cancel`)
      .set(owner.auth)
      .send({ version: 1, reason: 'Klient prosił' })
      .expect(200);
    expectError(
      (
        await ctx
          .http()
          .post(`${base}/appointments/${a.body.id}/cancel`)
          .set(owner.auth)
          .send({ version: 1, reason: 'Again' })
          .expect(409)
      ).body,
      'VERSION_CONFLICT',
    );
    const b = await manual({ start: at(day, 12) }).expect(201);
    expectError(
      (
        await ctx
          .http()
          .post(`${base}/appointments/${b.body.id}/status`)
          .set(owner.auth)
          .send({ version: 1, status: 'no_show' })
          .expect(400)
      ).body,
      'NOT_STARTED',
    );
  });

  it('a staff member sees and manages only their own appointments', async () => {
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.prisma.staffMember.update({
      where: { id: staffIds[0] },
      data: { userId: kasia.userId },
    });
    const own = await manual().expect(201);
    const other = await manual({ staffId: staffIds[1] }).expect(201);

    const list = await ctx
      .http()
      .get(`${base}/appointments`)
      .query({ from: day, to: day })
      .set(kasia.auth)
      .expect(200);
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([own.body.id]);
    await ctx.http().get(`${base}/appointments/${other.body.id}`).set(kasia.auth).expect(404);
    await manual({ staffId: staffIds[1], start: at(day, 15) }, kasia.auth).expect(403);
    await manual({ start: at(day, 15) }, kasia.auth).expect(201);
  });

  it('client list and visit history for the owner', async () => {
    await book(at(day, 10));
    const list = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/customers`)
      .set(owner.auth)
      .expect(200);
    expect(list.body).toHaveLength(1);
    const detail = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/customers/${list.body[0].id}`)
      .set(owner.auth)
      .expect(200);
    expect(detail.body.visits).toHaveLength(1);
    expect(detail.body.marketingConsent).toBe(false);
  });
});

describe('times across daylight saving', () => {
  it('an appointment over the 25.10.2026 change lasts exactly its duration', () => {
    const start = zonedToInstant('2026-10-25', 2 * 60 + 30, TZ); // 02:30 CEST
    const t = timesFor(start, { durationMinutes: 90, bufferMinutes: 15 });
    expect(t.endAt.getTime() - t.startAt.getTime()).toBe(90 * 60_000);
    expect(t.blockedUntil.getTime() - t.endAt.getTime()).toBe(15 * 60_000);
  });
});
