import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARD,
  evaluateGuard,
  type GuardIncident,
} from '../src/cancellation-guard/cancellation-guard.service';
import { OutboxService } from '../src/booking/outbox.service';
import { registeredResponseSchema } from '../src/common/openapi';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LEGAL_TEXTS,
  signUp,
  resetState,
  type SignedInUser,
  type TestContext,
} from './helpers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let ctx: TestContext;
let owner: SignedInUser;
let staffUser: SignedInUser;
let orgId: string;
let base: string;
let guardUrl: string;
let slug: string;
let serviceId: string;
let staffId: string;
let slot = 0;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  slot = 0;
  owner = await signUp(ctx, 'owner@example.com');
  let locationId: string;
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  guardUrl = `${base}/cancellation-guard`;
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
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
  staffUser = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: staffUser.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
});

/** A visit booked by the salon for the client with this email; returns its id and client. */
async function book(
  email: string,
  name = 'Jan Nowak',
): Promise<{ id: string; customerId: string }> {
  slot += 1;
  const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 3 * DAY + slot * HOUR);
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId,
      staffId,
      start: start.toISOString(),
      allowOutsideHours: true,
      customer: { name, phone: `+4860000${String(1000 + slot)}`, email },
    });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { id: res.body.id, customerId: res.body.customer.id };
}

/** The client cancelled (or moved) the visit at `at`; the visit was to start at `visitStart`. */
async function clientChange(
  email: string,
  type: 'cancelled' | 'rescheduled',
  at: Date,
  visitStart = new Date(at.getTime() + 2 * DAY),
  actor: 'customer' | 'staff' = 'customer',
): Promise<string> {
  const visit = await book(email);
  await ctx.prisma.appointment.update({
    where: { id: visit.id },
    data: {
      startAt: visitStart,
      endAt: new Date(visitStart.getTime() + 30 * MINUTE),
      blockedUntil: new Date(visitStart.getTime() + 30 * MINUTE),
      ...(type === 'cancelled'
        ? {
            status: 'cancelled',
            cancelledAt: at,
            cancelledBy: actor === 'customer' ? 'customer' : 'salon',
          }
        : {}),
    },
  });
  await ctx.prisma.appointmentEvent.create({
    data: { appointmentId: visit.id, type, actor, createdAt: at },
  });
  return visit.customerId;
}

/** A missed visit `daysAgo` days ago. */
async function noShow(email: string, daysAgo: number, discountGrosze = 0): Promise<string> {
  const visit = await book(email);
  const start = new Date(Date.now() - daysAgo * DAY);
  await ctx.prisma.appointment.update({
    where: { id: visit.id },
    data: {
      startAt: start,
      endAt: new Date(start.getTime() + 30 * MINUTE),
      blockedUntil: new Date(start.getTime() + 30 * MINUTE),
      status: 'no_show',
      discountGrosze,
    },
  });
  return visit.customerId;
}

async function setGuard(settings: object, version = 0) {
  return ctx
    .http()
    .put(guardUrl)
    .set(owner.auth)
    .send({
      version,
      enabled: true,
      maxChanges: null,
      windowHours: 720,
      lateCancelMinutes: null,
      maxNoShows: null,
      action: 'phone_only',
      ...settings,
    })
    .expect(200);
}

const marked = async () =>
  (await ctx.http().get(`${guardUrl}/clients`).set(owner.auth).expect(200)).body;

describe('cancellation guard: settings', () => {
  it('is off by default, saves with versions, needs a rule and writes the change log', async () => {
    const first = await ctx.http().get(guardUrl).set(owner.auth).expect(200);
    expect(first.body).toEqual({
      enabled: false,
      maxChanges: null,
      windowHours: 720,
      lateCancelMinutes: null,
      maxNoShows: null,
      action: 'approval',
      version: 0,
    });
    expect(registeredResponseSchema('CancellationGuard').safeParse(first.body).success).toBe(true);

    const noRule = await ctx
      .http()
      .put(guardUrl)
      .set(owner.auth)
      .send({ ...first.body, enabled: true })
      .expect(400);
    expectError(noRule.body, 'VALIDATION_ERROR');

    const saved = await setGuard({ maxNoShows: 2, action: 'prepay' });
    expect(saved.body).toMatchObject({
      enabled: true,
      maxNoShows: 2,
      action: 'prepay',
      version: 1,
    });

    // Someone saved in between: the old version is refused.
    const stale = await ctx
      .http()
      .put(guardUrl)
      .set(owner.auth)
      .send({ ...saved.body, version: 0 })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');

    const off = await ctx
      .http()
      .put(guardUrl)
      .set(owner.auth)
      .send({ ...saved.body, enabled: false })
      .expect(200);
    expect(off.body).toMatchObject({ enabled: false, maxNoShows: 2, version: 2 });

    const log = await ctx.prisma.auditLog.findMany({
      where: { action: 'location.cancellation_guard_set' },
      orderBy: { createdAt: 'asc' },
    });
    expect(log.map((l) => l.metadata)).toEqual([
      { fields: ['enabled', 'maxNoShows', 'action'] },
      { fields: ['enabled'] },
    ]);
  });

  it('is only for owners and managers', async () => {
    await ctx.http().get(guardUrl).set(staffUser.auth).expect(403);
    await ctx.http().get(`${guardUrl}/clients`).set(staffUser.auth).expect(403);
    await ctx
      .http()
      .put(guardUrl)
      .set(staffUser.auth)
      .send({ ...DEFAULT_GUARD, version: 0 })
      .expect(403);
  });
});

describe('cancellation guard: marked clients', () => {
  it('marks N cancellations or reschedules by the client within X hours', async () => {
    await setGuard({ maxChanges: 2, windowHours: 24 });
    const now = Date.now();
    const jan = await clientChange('jan@example.com', 'cancelled', new Date(now - 2 * HOUR));
    await clientChange('jan@example.com', 'rescheduled', new Date(now - 20 * HOUR));
    // Ewa: one change in the window, one older, one cancelled by the salon — not marked.
    await clientChange('ewa@example.com', 'cancelled', new Date(now - HOUR));
    await clientChange('ewa@example.com', 'cancelled', new Date(now - 30 * HOUR));
    await clientChange('ewa@example.com', 'cancelled', new Date(now - HOUR), undefined, 'staff');

    const list = await marked();
    expect(registeredResponseSchema('GuardedClients').safeParse(list).error?.issues ?? []).toEqual(
      [],
    );
    expect(list).toMatchObject({ enabled: true, action: 'phone_only', currency: 'PLN' });
    expect(list.items).toEqual([
      {
        customerId: jan,
        name: 'Jan Nowak',
        phone: expect.any(String),
        email: 'jan@example.com',
        reasons: ['changes'],
        changes: 2,
        lateCancellations: 0,
        noShows: 0,
        noShowAmountGrosze: 0,
        releasedAt: null,
      },
    ]);
  });

  it('marks a cancellation later than Y minutes before the visit', async () => {
    await setGuard({ lateCancelMinutes: 120 });
    const now = Date.now();
    const late = await clientChange(
      'late@example.com',
      'cancelled',
      new Date(now - 3 * HOUR),
      new Date(now - 2 * HOUR),
    );
    // Exactly 120 minutes before is in time.
    await clientChange(
      'ontime@example.com',
      'cancelled',
      new Date(now - 4 * HOUR),
      new Date(now - 2 * HOUR),
    );
    const list = await marked();
    expect(list.items.map((c: { customerId: string }) => c.customerId)).toEqual([late]);
    expect(list.items[0]).toMatchObject({ reasons: ['late_cancel'], lateCancellations: 1 });
  });

  it('marks M no-shows with what the missed visits cost, and lifting starts counting again', async () => {
    await setGuard({ maxNoShows: 2, action: 'prepay' });
    const jan = await noShow('jan@example.com', 10);
    await noShow('jan@example.com', 3, 1000);
    await noShow('ewa@example.com', 3);
    // Older than a year: not counted.
    await noShow('ewa@example.com', 400);

    const list = await marked();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      customerId: jan,
      reasons: ['no_shows'],
      noShows: 2,
      noShowAmountGrosze: 8000 + 7000,
    });

    const one = await ctx.http().get(`${guardUrl}/clients/${jan}`).set(owner.auth).expect(200);
    expect(
      registeredResponseSchema('GuardedClient').safeParse(one.body).error?.issues ?? [],
    ).toEqual([]);
    expect(one.body).toMatchObject({ flagged: true, action: 'prepay', noShows: 2 });
    expect(one.body.history.map((h: { type: string }) => h.type)).toEqual(['no_show', 'no_show']);

    const lifted = await ctx
      .http()
      .post(`${guardUrl}/clients/${jan}/release`)
      .set(owner.auth)
      .send({ note: 'Zapłacił 150 zł w salonie' })
      .expect(200);
    expect(lifted.body).toMatchObject({
      flagged: false,
      reasons: [],
      noShows: 0,
      noShowAmountGrosze: 0,
      releasedAt: expect.any(String),
    });
    expect(lifted.body.history[0]).toMatchObject({
      type: 'released',
      note: 'Zapłacił 150 zł w salonie',
    });
    expect(lifted.body.history).toHaveLength(3);
    expect((await marked()).items).toEqual([]);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'customer.guard_released', entityId: jan },
      }),
    ).toBe(1);
  });

  it('shows nobody while the guard is off, but keeps the counters on the card', async () => {
    const saved = await setGuard({ maxNoShows: 1 });
    const jan = await noShow('jan@example.com', 2);
    expect((await marked()).items).toHaveLength(1);
    await ctx
      .http()
      .put(guardUrl)
      .set(owner.auth)
      .send({ ...saved.body, enabled: false })
      .expect(200);
    expect(await marked()).toMatchObject({ enabled: false, items: [] });
    const card = await ctx.http().get(`${guardUrl}/clients/${jan}`).set(owner.auth).expect(200);
    expect(card.body).toMatchObject({ enabled: false, flagged: false, noShows: 1 });
  });

  it('never shows clients of another salon', async () => {
    await setGuard({ maxNoShows: 1 });
    const jan = await noShow('jan@example.com', 2);
    const other = await signUp(ctx, 'other@example.com');
    const { orgId: otherOrg, locationId: otherLoc } = await createOrgWithLocation(
      ctx,
      other,
      'Other',
    );
    const otherGuard = `/v1/organizations/${otherOrg}/locations/${otherLoc}/cancellation-guard`;
    await ctx.http().get(`${otherGuard}/clients/${jan}`).set(other.auth).expect(404);
    await ctx
      .http()
      .post(`${otherGuard}/clients/${jan}/release`)
      .set(other.auth)
      .send({})
      .expect(404);
    await ctx.http().get(`${guardUrl}/clients`).set(other.auth).expect(404);
    expect(await ctx.prisma.cancellationGuardRelease.count()).toBe(0);
  });
});

describe('cancellation guard: online booking (161b)', () => {
  const ANNA = {
    name: 'Anna Kowalska',
    phone: '+48 600 100 200',
    email: 'anna@example.com',
    locale: 'pl',
    acceptTerms: true,
  };

  beforeEach(async () => {
    await ctx
      .http()
      .put(`${base}/staff/${staffId}/working-hours`)
      .set(owner.auth)
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '00:00', end: '24:00' }],
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

  /** Holds a slot two days ahead, sends the code by email and confirms it. */
  async function bookOnline(client = ANNA) {
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 2 * DAY + (slot += 1) * HOUR);
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start: start.toISOString() })
      .expect(201);
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({ holdToken: hold.body.holdToken, ...client })
      .expect(202);
    const code = ctx.mail.lastTo(client.email)?.text.match(/\b(\d{6})\b/)?.[1];
    const res = await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
      .send({ holdToken: hold.body.holdToken, code });
    return { res, holdId: hold.body.holdId as string };
  }

  it('asks a marked client to pay the missed visits in the salon first, and lets the slot go', async () => {
    await setGuard({ maxNoShows: 1, action: 'prepay' });
    const anna = await noShow(ANNA.email, 5, 500);
    const { res, holdId } = await bookOnline();
    expect(res.status).toBe(403);
    expectError(res.body, 'BOOKING_PAY_FIRST');
    expect(res.body.error.details).toEqual([
      { path: 'amountGrosze', message: '7500' },
      { path: 'currency', message: 'PLN' },
    ]);
    expect((await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: holdId } })).status).toBe(
      'expired',
    );

    // Paid in the salon: the owner lifts the mark and the client books again.
    await ctx
      .http()
      .post(`${guardUrl}/clients/${anna}/release`)
      .set(owner.auth)
      .send({})
      .expect(200);
    expect((await bookOnline()).res.status).toBe(200);
  });

  it('asks a marked client to book by phone', async () => {
    await setGuard({ maxNoShows: 1, action: 'phone_only' });
    await noShow(ANNA.email, 5);
    const { res } = await bookOnline();
    expect(res.status).toBe(403);
    expectError(res.body, 'BOOKING_PHONE_ONLY');
    // Another client books as usual.
    expect((await bookOnline({ ...ANNA, email: 'ewa@example.com' })).res.status).toBe(200);
  });

  /** Emails to this address apart from the booking codes. */
  const subjects = (email: string) =>
    ctx.mail
      .allTo(email)
      .map((m) => m.subject)
      .filter((subject) => !subject.startsWith('Kod'));

  const reminders = (appointmentId: string) =>
    ctx.prisma.notificationOutbox.count({
      where: {
        type: 'client_reminder',
        payload: { path: ['appointmentId'], equals: appointmentId },
      },
    });

  it('keeps the time of a client marked for approval until the salon accepts the visit', async () => {
    const outbox = ctx.app.get(OutboxService);
    await setGuard({ maxNoShows: 1, action: 'approval' });
    await noShow(ANNA.email, 5);
    await outbox.drain();
    ctx.mail.clear();

    const { res, holdId } = await bookOnline();
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({ status: 'confirmed', awaitingApproval: true });
    await outbox.drain();
    expect(subjects(ANNA.email)).toEqual([
      'Rezerwacja czeka na potwierdzenie salonu — Barber Centrum',
    ]);
    expect(ctx.mail.allTo(owner.email).map((m) => m.subject)).toEqual([
      'Rezerwacja do potwierdzenia — Barber Centrum',
    ]);
    // The time stays taken while the salon decides.
    const visit = await ctx
      .http()
      .get(`${base}/appointments/${holdId}`)
      .set(owner.auth)
      .expect(200);
    expect(visit.body).toMatchObject({ status: 'confirmed', awaitingApproval: true });
    expect(await reminders(holdId)).toBe(0);

    // A specialist without the visit in their calendar cannot accept it; nobody else's salon can.
    const stranger = await signUp(ctx, 'stranger@example.com');
    const strange = await createOrgWithLocation(ctx, stranger, 'Inny');
    await ctx
      .http()
      .post(
        `/v1/organizations/${strange.orgId}/locations/${strange.locationId}/appointments/${holdId}/approve`,
      )
      .set(stranger.auth)
      .send({ version: visit.body.version })
      .expect(404);

    const approved = await ctx
      .http()
      .post(`${base}/appointments/${holdId}/approve`)
      .set(owner.auth)
      .send({ version: visit.body.version })
      .expect(200);
    expect(approved.body).toMatchObject({
      awaitingApproval: false,
      version: visit.body.version + 1,
    });
    expect(approved.body.history.map((h: { type: string }) => h.type)).toContain('approved');
    await outbox.drain();
    expect(subjects(ANNA.email)).toEqual([
      'Rezerwacja czeka na potwierdzenie salonu — Barber Centrum',
      'Wizyta potwierdzona — Barber Centrum',
    ]);
    expect(await reminders(holdId)).toBe(1);
    // Accepting twice is a conflict, not a second email.
    const again = await ctx
      .http()
      .post(`${base}/appointments/${holdId}/approve`)
      .set(owner.auth)
      .send({ version: approved.body.version });
    expect(again.status).toBe(409);
    expectError(again.body, 'NOT_AWAITING_APPROVAL');

    // The client's link shows the visit as accepted.
    const manage = res.body.manageToken as string;
    const byLink = await ctx.http().get(`/v1/public/appointments/${manage}`).expect(200);
    expect(byLink.body.awaitingApproval).toBe(false);
  });

  it('refusing a visit that waits is cancelling it with a reason', async () => {
    const outbox = ctx.app.get(OutboxService);
    await setGuard({ maxNoShows: 1, action: 'approval' });
    await noShow(ANNA.email, 5);
    const { res, holdId } = await bookOnline();
    expect(res.body.appointment.awaitingApproval).toBe(true);
    const byLink = await ctx
      .http()
      .get(`/v1/public/appointments/${res.body.manageToken}`)
      .expect(200);
    expect(byLink.body.awaitingApproval).toBe(true);
    await outbox.drain();
    ctx.mail.clear();
    const visit = await ctx
      .http()
      .get(`${base}/appointments/${holdId}`)
      .set(owner.auth)
      .expect(200);
    const cancelled = await ctx
      .http()
      .post(`${base}/appointments/${holdId}/cancel`)
      .set(owner.auth)
      .send({ version: visit.body.version, reason: 'Prosimy o kontakt telefoniczny' })
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', awaitingApproval: false });
    await outbox.drain();
    const mail = ctx.mail.lastTo(ANNA.email);
    expect(mail?.subject).toBe('Wizyta odwołana — Barber Centrum');
    expect(mail?.text).toContain('Prosimy o kontakt telefoniczny');
    await ctx
      .http()
      .post(`${base}/appointments/${holdId}/approve`)
      .set(owner.auth)
      .send({ version: cancelled.body.version })
      .expect(409);
  });

  it('lets everyone book while the guard is off', async () => {
    const saved = await setGuard({ maxNoShows: 1, action: 'phone_only' });
    await noShow(ANNA.email, 5);
    await ctx
      .http()
      .put(guardUrl)
      .set(owner.auth)
      .send({ ...saved.body, enabled: false })
      .expect(200);
    expect((await bookOnline()).res.status).toBe(200);
  });
});

describe('evaluateGuard', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const change = (hoursAgo: number): GuardIncident => ({
    type: 'rescheduled',
    at: new Date(now.getTime() - hoursAgo * HOUR),
    visitStart: new Date(now.getTime() + DAY),
    appointmentId: 'a',
    amountGrosze: 0,
  });

  it('counts the window inclusively and ignores rules left empty', () => {
    const settings = { ...DEFAULT_GUARD, enabled: true, maxChanges: 2, windowHours: 24 };
    expect(evaluateGuard(settings, [change(24), change(1)], now).reasons).toEqual(['changes']);
    expect(evaluateGuard(settings, [change(25), change(1)], now).reasons).toEqual([]);
    expect(
      evaluateGuard({ ...settings, maxChanges: null }, [change(2), change(1)], now),
    ).toMatchObject({ reasons: [], changes: 2 });
  });
});
