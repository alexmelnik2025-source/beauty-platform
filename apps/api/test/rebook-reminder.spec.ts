import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { customerFromToken, unsubscribeToken } from '../src/booking/rebook-reminder';
import { RebookReminderService } from '../src/booking/rebook-reminder.service';
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

/** Task 165c: "time for your next visit" — set up by the salon, one email per visit. */

const TZ = 'Europe/Warsaw';
const DAY_MS = 86_400_000;
const ANNA = {
  name: 'Anna Kowalska',
  phone: '+48 600 100 200',
  email: 'anna.client@example.com',
  locale: 'pl',
  acceptTerms: true,
  marketingConsent: true,
};

let ctx: TestContext;
let reminders: RebookReminderService;
let owner: SignedInUser;
let slug: string;
let base: string;
let serviceId: string;
let staffId: string;
let day: string;

beforeAll(async () => {
  ctx = await createTestApp();
  reminders = ctx.app.get(RebookReminderService);
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
  await ctx
    .http()
    .put(`${base}/staff/${staffId}/working-hours`)
    .set(owner.auth)
    .send({
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        intervals: [{ start: '09:00', end: '18:00' }],
      })),
    })
    .expect(200);
  await settings({ onlineBookingEnabled: true, ...LEGAL_TEXTS });
  day = addDays(localToday(Date.now(), TZ), 3);
});

async function settings(changes: object, status = 200) {
  const loc = await ctx.http().get(base).set(owner.auth);
  return ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, ...changes })
    .expect(status);
}

/** Books online (with or without the marketing consent) and returns the visit id. */
async function book(hh: number, client = ANNA): Promise<string> {
  const start = new Date(zonedToInstant(day, hh * 60, TZ)).toISOString();
  const h = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/code`)
    .send({ holdToken: h.body.holdToken, ...client })
    .expect(202);
  const code = ctx.mail.lastTo(client.email)?.text.match(/\b(\d{6})\b/)?.[1];
  const c = await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/confirm`)
    .send({ holdToken: h.body.holdToken, code })
    .expect(200);
  return c.body.appointment.id;
}

/** Moves a visit `daysAgo` days into the past and marks it as it went. */
async function tookPlace(id: string, daysAgo: number, status: 'completed' | 'confirmed') {
  const start = new Date(Date.now() - daysAgo * DAY_MS);
  const end = new Date(start.getTime() + 30 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id },
    data: { startAt: start, endAt: end, blockedUntil: end, status },
  });
}

const queued = () => ctx.prisma.notificationOutbox.count({ where: { type: 'rebook_reminder' } });

describe('"time for your next visit"', () => {
  it('the salon switches it on with its days and its own words; checked by the API', async () => {
    const off = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(off.body.rebookReminderDays).toBe(0);
    expect(off.body.rebookReminderText).toBeNull();
    expectError((await settings({ rebookReminderDays: 3 }, 400)).body, 'VALIDATION_ERROR');
    expectError(
      (await settings({ rebookReminderText: 'x'.repeat(501) }, 400)).body,
      'VALIDATION_ERROR',
    );
    const on = await settings({
      rebookReminderDays: 28,
      rebookReminderText: '  Dawno Cię nie było — wpadnij na strzyżenie!  ',
    });
    expect(on.body.rebookReminderDays).toBe(28);
    expect(on.body.rebookReminderText).toBe('Dawno Cię nie było — wpadnij na strzyżenie!');
    const cleared = await settings({ rebookReminderText: '' });
    expect(cleared.body.rebookReminderText).toBeNull();
  });

  it('one email N days after the last visit, from the salon, with a booking link', async () => {
    const id = await book(10);
    await tookPlace(id, 27, 'completed');
    expect(await reminders.run()).toBe(0); // switched off
    await settings({ rebookReminderDays: 28 });
    expect(await reminders.run()).toBe(0); // 27 days: not yet
    await tookPlace(id, 29, 'completed');
    expect(await reminders.run()).toBe(1);
    expect(await reminders.run()).toBe(0); // once per visit
    await ctx.app.get(OutboxService).drain();
    const mail = ctx.mail.lastTo(ANNA.email)!;
    expect(mail.subject).toBe('Barber Centrum: pora na kolejną wizytę?');
    expect(mail.text).toContain('Pora na kolejną?');
    expect(mail.text).toContain('(Strzyżenie, Kasia)');
    expect(mail.text).toContain(`/pl/b/${slug}?service=${serviceId}&staff=${staffId}`);
    expect(mail.text).toMatch(/Wypisz się: \S+\/pl\/u\/\S+/);

    // The salon's own words replace the platform's.
    await settings({ rebookReminderText: 'Pora odświeżyć fade!' });
    const second = await book(12);
    await tookPlace(second, 30, 'confirmed'); // nobody marked it, but it took place
    await ctx.prisma.appointment.update({
      where: { id },
      data: {
        startAt: new Date(Date.now() - 40 * DAY_MS),
        endAt: new Date(Date.now() - 40 * DAY_MS + 1_800_000),
        blockedUntil: new Date(Date.now() - 40 * DAY_MS + 1_800_000),
      },
    });
    expect(await reminders.run()).toBe(1);
    await ctx.app.get(OutboxService).drain();
    const own = ctx.mail.lastTo(ANNA.email)!;
    expect(own.text.startsWith('Pora odświeżyć fade!')).toBe(true);
  });

  it('not without consent, not with a booking ahead, not after a no-show, not long-past visits', async () => {
    await settings({ rebookReminderDays: 28 });
    const noConsent = await book(10, {
      ...ANNA,
      email: 'ola@example.com',
      marketingConsent: false,
    });
    await tookPlace(noConsent, 29, 'completed');
    const noShow = await book(11, { ...ANNA, email: 'piotr@example.com' });
    await tookPlace(noShow, 29, 'no_show' as 'completed');
    const longAgo = await book(12, { ...ANNA, email: 'jan@example.com' });
    await tookPlace(longAgo, 60, 'completed');
    const last = await book(13);
    await tookPlace(last, 29, 'completed');
    await book(14); // Anna has booked again
    expect(await reminders.run()).toBe(0);
  });

  it('a queued email does not go when the client has booked meanwhile', async () => {
    await settings({ rebookReminderDays: 28 });
    const id = await book(10);
    await tookPlace(id, 29, 'completed');
    expect(await reminders.run()).toBe(1);
    await book(11);
    await ctx.app.get(OutboxService).drain();
    const subjects = ctx.mail.allTo(ANNA.email).map((m) => m.subject);
    expect(subjects.some((s) => s.includes('pora na kolejną'))).toBe(false);
    const row = await ctx.prisma.notificationOutbox.findFirst({
      where: { type: 'rebook_reminder' },
    });
    expect(row?.status).toBe('skipped');
  });

  it('the unsubscribe link withdraws the consent; no more reminders', async () => {
    await settings({ rebookReminderDays: 28 });
    const id = await book(10);
    await tookPlace(id, 29, 'completed');
    expect(await reminders.run()).toBe(1);
    await ctx.app.get(OutboxService).drain();
    const link = /\/pl\/u\/(\S+)/.exec(ctx.mail.lastTo(ANNA.email)!.text)![1]!;
    const token = decodeURIComponent(link);

    expectError(
      (
        await ctx
          .http()
          .post('/v1/public/unsubscribe')
          .send({ token: `${token}x` })
          .expect(404)
      ).body,
      'NOT_FOUND',
    );
    const done = await ctx.http().post('/v1/public/unsubscribe').send({ token }).expect(200);
    expect(done.body).toEqual({ salonName: 'Barber Centrum' });
    await ctx.http().post('/v1/public/unsubscribe').send({ token }).expect(200);
    const consents = await ctx.prisma.consentRecord.findMany({
      where: { type: 'marketing' },
      orderBy: { createdAt: 'asc' },
    });
    expect(consents.map((c) => c.granted)).toEqual([true, false]);

    // A new visit later: no reminder without the consent.
    await ctx.prisma.notificationOutbox.deleteMany({ where: { type: 'rebook_reminder' } });
    expect(await queued()).toBe(0);
    expect(await reminders.run()).toBe(0);
  });

  it('a link made for one client never works for another', () => {
    const id = '0192f000-0000-7000-8000-000000000001';
    const token = unsubscribeToken('secret-a', id);
    expect(customerFromToken('secret-a', token)).toBe(id);
    expect(customerFromToken('secret-b', token)).toBeNull();
    const other = '0192f000-0000-7000-8000-000000000002';
    expect(customerFromToken('secret-a', `${other}.${token.split('.')[1]}`)).toBeNull();
    expect(customerFromToken('secret-a', 'nonsense')).toBeNull();
  });
});
