import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { ReviewRequestService } from '../src/reviews/review-request.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 165b, part 2: the "How was it?" email after the visit. */

const TZ = 'Europe/Warsaw';
const DAY_MS = 86_400_000;
const client = (email: string, name = 'Anna Kowalska') => ({
  name,
  phone: '+48 600 100 200',
  email,
  locale: 'pl',
  acceptTerms: true,
  marketingConsent: true,
});
const ANNA = client('anna.client@example.com');
const BOB = client('bob.client@example.com', 'Bob Nowak');

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let serviceId: string;
let kasiaId: string;
let day: string;
let requests: ReviewRequestService;

beforeAll(async () => {
  ctx = await createTestApp();
  requests = ctx.app.get(ReviewRequestService);
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
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  const ids: string[] = [];
  for (const displayName of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName, serviceIds: [serviceId] })
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
    ids.push(staff.body.id);
  }
  [kasiaId] = ids as [string, string];
  const loc = await ctx.http().get(base).set(owner.auth);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

/** Books online and returns the visit id and its "manage" token. */
async function book(hh: number, staffId = kasiaId, who = ANNA) {
  const start = new Date(zonedToInstant(day, hh * 60, TZ)).toISOString();
  const h = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/code`)
    .send({ holdToken: h.body.holdToken, ...who })
    .expect(202);
  const code = ctx.mail.lastTo(who.email)?.text.match(/\b(\d{6})\b/)?.[1];
  const c = await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/confirm`)
    .send({ holdToken: h.body.holdToken, code })
    .expect(200);
  return { id: c.body.appointment.id as string, token: c.body.manageToken as string };
}

/** Moves a visit into the past (ended `daysAgo` days ago) with the given status. */
async function tookPlace(
  id: string,
  daysAgo: number,
  status: 'completed' | 'confirmed' | 'no_show' | 'cancelled' = 'completed',
) {
  const end = new Date(Date.now() - daysAgo * DAY_MS);
  const start = new Date(end.getTime() - 30 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id },
    data: { startAt: start, endAt: end, blockedUntil: end, status },
  });
  // The "manage" link stays valid in these tests.
  await ctx.prisma.appointmentAccessToken.updateMany({
    where: { appointmentId: id },
    data: { expiresAt: new Date(Date.now() + 30 * DAY_MS) },
  });
}

async function switchOn(requestHours = 3) {
  const current = await ctx.http().get(`${base}/review-settings`).set(owner.auth).expect(200);
  return ctx
    .http()
    .put(`${base}/review-settings`)
    .set(owner.auth)
    .send({ version: current.body.version, enabled: true, requestHours })
    .expect(200);
}

const review = (token: string, body: object, status = 200) =>
  ctx.http().put(`/v1/public/appointments/${token}/review`).send(body).expect(status);

/** Moves the visit so it ended `hoursAgo` hours ago. */
const endedHoursAgo = (
  id: string,
  hoursAgo: number,
  status: 'completed' | 'confirmed' = 'completed',
) => tookPlace(id, hoursAgo / 24, status);

const drain = () => ctx.app.get(OutboxService).drain();

describe('"How was it?" email', () => {
  it('one email N hours after the visit, from the salon, with a link to the review form', async () => {
    const visit = await book(10);
    await endedHoursAgo(visit.id, 4);
    expect(await requests.run()).toBe(0); // the salon does not collect reviews
    await switchOn(5);
    expect(await requests.run()).toBe(0); // 4 hours: not yet
    await endedHoursAgo(visit.id, 6);
    expect(await requests.run()).toBe(1);
    expect(await requests.run()).toBe(0); // once per visit
    await drain();
    const mail = ctx.mail.lastTo(ANNA.email)!;
    expect(mail.subject).toMatch(/: jak było\?$/);
    expect(mail.text).toContain('(Strzyżenie, Kasia)');
    const token = /\/pl\/m\/(\S+)#review/.exec(mail.text)![1]!;

    // The link opens the review form.
    const form = await ctx.http().get(`/v1/public/appointments/${token}/review`).expect(200);
    expect(form.body).toMatchObject({ canReview: true, review: null });
    await review(token, { rating: 5 });
  });

  it('a past visit still "confirmed" counts; not without consent, email, after a no-show or long ago', async () => {
    await switchOn(2);
    const confirmed = await book(10, kasiaId, client('jan@example.com'));
    await endedHoursAgo(confirmed.id, 3, 'confirmed');
    const noConsent = await book(11, kasiaId, {
      ...client('ola@example.com'),
      marketingConsent: false,
    });
    await endedHoursAgo(noConsent.id, 3);
    const noShow = await book(12, kasiaId, client('piotr@example.com'));
    await tookPlace(noShow.id, 3 / 24, 'no_show');
    const longAgo = await book(13, kasiaId, client('ewa@example.com'));
    await endedHoursAgo(longAgo.id, 2 + 49);
    expect(await requests.run()).toBe(1);
    const row = await ctx.prisma.notificationOutbox.findFirstOrThrow({
      where: { type: 'review_request' },
    });
    expect(row.payload).toEqual({ appointmentId: confirmed.id });
  });

  it('a queued email does not go when the client already wrote a review or the salon switched off', async () => {
    await switchOn(2);
    const reviewed = await book(10);
    const switchedOff = await book(11, kasiaId, BOB);
    await endedHoursAgo(reviewed.id, 3);
    await endedHoursAgo(switchedOff.id, 3);
    expect(await requests.run()).toBe(2);
    await review(reviewed.token, { rating: 4 });
    await drain();
    const rows = await ctx.prisma.notificationOutbox.findMany({
      where: { type: 'review_request' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.status).sort()).toEqual(['sent', 'skipped']);
    expect(ctx.mail.allTo(ANNA.email).some((m) => m.subject.includes('jak było'))).toBe(false);

    await ctx.prisma.notificationOutbox.deleteMany({ where: { type: 'review_request' } });
    const current = await ctx.http().get(`${base}/review-settings`).set(owner.auth);
    await ctx
      .http()
      .put(`${base}/review-settings`)
      .set(owner.auth)
      .send({ version: current.body.version, enabled: false, requestHours: 2 })
      .expect(200);
    const another = await book(12, kasiaId, client('jan@example.com'));
    await endedHoursAgo(another.id, 3);
    expect(await requests.run()).toBe(0);
  });

  it('the email is in the client’s language', async () => {
    await switchOn(2);
    const visit = await book(10, kasiaId, { ...client('olga@example.com'), locale: 'uk' });
    await endedHoursAgo(visit.id, 3);
    expect(await requests.run()).toBe(1);
    await drain();
    const mail = ctx.mail.lastTo('olga@example.com')!;
    expect(mail.subject).toMatch(/: як усе пройшло\?$/);
    expect(mail.text).toMatch(/Оцінити візит: \S+\/uk\/m\/\S+#review/);
  });
});
