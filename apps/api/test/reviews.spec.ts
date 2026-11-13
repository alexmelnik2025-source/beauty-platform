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

/** Task 165b: reviews after the visit — switched on by the salon, one per visit that took place. */

const TZ = 'Europe/Warsaw';
const DAY_MS = 86_400_000;
const client = (email: string, name = 'Anna Kowalska') => ({
  name,
  phone: '+48 600 100 200',
  email,
  locale: 'pl',
  acceptTerms: true,
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
let olaId: string;
let day: string;

beforeAll(async () => {
  ctx = await createTestApp();
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
  [kasiaId, olaId] = ids as [string, string];
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

async function signIn(email: string): Promise<{ Authorization: string }> {
  await ctx.http().post('/v1/client/auth/code').send({ email, locale: 'pl' }).expect(202);
  const code = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/)?.[1];
  const res = await ctx
    .http()
    .post('/v1/client/auth/verify')
    .send({ email, code, clientType: 'mobile' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

describe('review settings', () => {
  it('are off until the salon saves them; versioned; checked by the API; logged', async () => {
    const off = await ctx.http().get(`${base}/review-settings`).set(owner.auth).expect(200);
    expect(off.body).toEqual({ enabled: false, requestHours: 2, version: 0 });

    const bad = await ctx
      .http()
      .put(`${base}/review-settings`)
      .set(owner.auth)
      .send({ version: 0, enabled: true, requestHours: 0 })
      .expect(400);
    expectError(bad.body, 'VALIDATION_ERROR');

    const on = await switchOn(5);
    expect(on.body).toEqual({ enabled: true, requestHours: 5, version: 1 });

    const stale = await ctx
      .http()
      .put(`${base}/review-settings`)
      .set(owner.auth)
      .send({ version: 0, enabled: false, requestHours: 5 })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');

    const log = await ctx.prisma.auditLog.findMany({
      where: { action: 'location.review_settings_set' },
    });
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata).toEqual({ fields: ['enabled', 'requestHours'] });
  });

  it('only owners and managers of the location; another salon sees nothing', async () => {
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.http().get(`${base}/review-settings`).set(kasia.auth).expect(403);
    await ctx
      .http()
      .put(`${base}/review-settings`)
      .set(kasia.auth)
      .send({ version: 0, enabled: true, requestHours: 2 })
      .expect(403);

    const other = await signUp(ctx, 'other@example.com');
    const theirs = await createOrgWithLocation(ctx, other, 'Other');
    await ctx
      .http()
      .get(`/v1/organizations/${theirs.orgId}/locations/${locationId}/review-settings`)
      .set(other.auth)
      .expect(404);
    await ctx.http().get(`${base}/reviews`).set(other.auth).expect(404);
  });
});

describe('writing a review', () => {
  it('only after the visit took place, while the salon collects reviews, for 30 days', async () => {
    const visit = await book(10);
    // Before the visit.
    const before = await ctx.http().get(`/v1/public/appointments/${visit.token}/review`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ canReview: false, reviewUntil: null, review: null });

    await tookPlace(visit.id, 1);
    // The salon does not collect reviews yet.
    expectError((await review(visit.token, { rating: 5 }, 409)).body, 'REVIEW_NOT_POSSIBLE');

    await switchOn();
    const open = await ctx.http().get(`/v1/public/appointments/${visit.token}/review`).expect(200);
    expect(open.body.canReview).toBe(true);
    expect(new Date(open.body.reviewUntil).getTime()).toBeGreaterThan(Date.now() + 28 * DAY_MS);

    const written = await review(visit.token, { rating: 5, text: '  Super strzyżenie!  ' });
    expect(written.body.review).toMatchObject({ rating: 5, text: 'Super strzyżenie!' });

    // Changing it keeps one review; an empty text removes the words.
    const changed = await review(visit.token, { rating: 4, text: '' });
    expect(changed.body.review).toMatchObject({ rating: 4, text: null });
    expect(await ctx.prisma.visitReview.count()).toBe(1);

    expectError((await review(visit.token, { rating: 6 }, 400)).body, 'VALIDATION_ERROR');
    expectError((await review(visit.token, { rating: 0 }, 400)).body, 'VALIDATION_ERROR');
    expectError(
      (await review(visit.token, { rating: 3, text: 'x'.repeat(1001) }, 400)).body,
      'VALIDATION_ERROR',
    );

    // 31 days later — too late; the review stays.
    await tookPlace(visit.id, 31);
    const late = await ctx.http().get(`/v1/public/appointments/${visit.token}/review`).expect(200);
    expect(late.body).toMatchObject({ canReview: false, review: { rating: 4 } });
    expectError((await review(visit.token, { rating: 1 }, 409)).body, 'REVIEW_NOT_POSSIBLE');
  });

  it('a past visit still "confirmed" counts; no-shows and cancelled visits do not', async () => {
    await switchOn();
    const confirmed = await book(10);
    const noShow = await book(11);
    const cancelled = await book(12);
    await tookPlace(confirmed.id, 1, 'confirmed');
    await tookPlace(noShow.id, 1, 'no_show');
    await tookPlace(cancelled.id, 1, 'cancelled');
    await review(confirmed.token, { rating: 5 });
    expectError((await review(noShow.token, { rating: 1 }, 409)).body, 'REVIEW_NOT_POSSIBLE');
    expectError((await review(cancelled.token, { rating: 1 }, 409)).body, 'REVIEW_NOT_POSSIBLE');
  });

  it('a made-up link is 404', async () => {
    await ctx.http().get('/v1/public/appointments/nope/review').expect(404);
    await review('nope', { rating: 5 }, 404);
  });

  it('in the client app: only my own visits', async () => {
    await switchOn();
    const mine = await book(10);
    const bobs = await book(11, kasiaId, BOB);
    await tookPlace(mine.id, 2);
    await tookPlace(bobs.id, 2);
    const anna = await signIn(ANNA.email);

    await ctx.http().get(`/v1/client/appointments/${mine.id}/review`).expect(401);
    const got = await ctx
      .http()
      .get(`/v1/client/appointments/${mine.id}/review`)
      .set(anna)
      .expect(200);
    expect(got.body).toMatchObject({ canReview: true, review: null });
    const put = await ctx
      .http()
      .put(`/v1/client/appointments/${mine.id}/review`)
      .set(anna)
      .send({ rating: 3, text: 'OK' })
      .expect(200);
    expect(put.body.review).toMatchObject({ rating: 3, text: 'OK' });

    // Bob's visit looks like a missing one.
    await ctx.http().get(`/v1/client/appointments/${bobs.id}/review`).set(anna).expect(404);
    await ctx
      .http()
      .put(`/v1/client/appointments/${bobs.id}/review`)
      .set(anna)
      .send({ rating: 1 })
      .expect(404);
    await ctx.http().get('/v1/client/appointments/not-a-uuid/review').set(anna).expect(404);
  });
});

describe('showing reviews', () => {
  it('the salon page: averages per specialist, no client data, nothing while off', async () => {
    await switchOn();
    const a = await book(10, kasiaId);
    const b = await book(11, kasiaId, BOB);
    const c = await book(12, olaId);
    for (const v of [a, b, c]) await tookPlace(v.id, 1);
    await review(a.token, { rating: 5, text: 'Świetnie' });
    await review(b.token, { rating: 4 });
    await review(c.token, { rating: 2, text: 'Za krótko' });

    const page = await ctx.http().get(`/v1/public/locations/${slug}/reviews`).expect(200);
    expect(page.body).toMatchObject({ enabled: true, count: 3, average: 3.7, nextBefore: null });
    // Task 380: the reviews by stars, index 0 = one star.
    expect(page.body.stars).toEqual([0, 1, 0, 1, 1]);
    expect(page.body.staff).toEqual([
      { staffId: kasiaId, displayName: 'Kasia', count: 2, average: 4.5 },
      { staffId: olaId, displayName: 'Ola', count: 1, average: 2 },
    ]);
    expect(page.body.items.map((r: { rating: number }) => r.rating)).toEqual([2, 4, 5]);
    expect(Object.keys(page.body.items[0]).sort()).toEqual([
      'createdAt',
      'id',
      'rating',
      'repliedAt',
      'reply',
      'serviceName',
      'staffId',
      'staffName',
      'text',
    ]);
    expect(JSON.stringify(page.body)).not.toContain('Anna');

    // Task 384: the stars of each specialist on the salon page (the booking step shows them).
    const salonPage = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    const starsOf = (body: {
      staff: { id: string; rating: number | null; reviewCount: number }[];
    }) => body.staff.map((s) => [s.id, s.rating, s.reviewCount]);
    expect(starsOf(salonPage.body)).toEqual([
      [kasiaId, 4.5, 2],
      [olaId, 2, 1],
    ]);

    const kasias = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/reviews`)
      .query({ staffId: kasiaId })
      .expect(200);
    expect(kasias.body).toMatchObject({ count: 2, average: 4.5, stars: [0, 0, 0, 1, 1] });
    expect(kasias.body.items).toHaveLength(2);

    // Task 380: only the reviews with the stars asked for; the summary stays.
    const twos = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/reviews`)
      .query({ rating: 2 })
      .expect(200);
    expect(twos.body).toMatchObject({ count: 3, average: 3.7, stars: [0, 1, 0, 1, 1] });
    expect(twos.body.items.map((r: { text: string | null }) => r.text)).toEqual(['Za krótko']);
    const kasiaTwos = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/reviews`)
      .query({ staffId: kasiaId, rating: 2 })
      .expect(200);
    expect(kasiaTwos.body.items).toEqual([]);
    for (const bad of ['0', '6', '4.5', 'abc']) {
      await ctx
        .http()
        .get(`/v1/public/locations/${slug}/reviews`)
        .query({ rating: bad })
        .expect(400);
    }

    // Switched off: the reviews are kept but not shown.
    const current = await ctx.http().get(`${base}/review-settings`).set(owner.auth);
    await ctx
      .http()
      .put(`${base}/review-settings`)
      .set(owner.auth)
      .send({ version: current.body.version, enabled: false, requestHours: 3 })
      .expect(200);
    const off = await ctx.http().get(`/v1/public/locations/${slug}/reviews`).expect(200);
    expect(off.body).toEqual({
      enabled: false,
      count: 0,
      average: null,
      stars: [0, 0, 0, 0, 0],
      staff: [],
      items: [],
      nextBefore: null,
    });
    expect(await ctx.prisma.visitReview.count()).toBe(3);
    const salonOff = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(starsOf(salonOff.body)).toEqual([
      [kasiaId, null, 0],
      [olaId, null, 0],
    ]);

    await ctx.http().get('/v1/public/locations/no-such-salon/reviews').expect(404);
  });

  it('pages of 20, newest first', async () => {
    await switchOn();
    const visit = await book(10);
    await tookPlace(visit.id, 1);
    const template = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: visit.id } });
    const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = template;
    for (let i = 0; i < 22; i += 1) {
      const startAt = new Date(template.startAt.getTime() - (i + 1) * DAY_MS);
      const copy = await ctx.prisma.appointment.create({
        data: {
          ...fields,
          holdContact: undefined,
          startAt,
          endAt: new Date(startAt.getTime() + 30 * 60_000),
          blockedUntil: new Date(startAt.getTime() + 30 * 60_000),
        },
      });
      await ctx.prisma.visitReview.create({
        data: { appointmentId: copy.id, locationId, staffId: kasiaId, rating: (i % 5) + 1 },
      });
    }
    const first = await ctx.http().get(`/v1/public/locations/${slug}/reviews`).expect(200);
    expect(first.body.items).toHaveLength(20);
    expect(first.body.count).toBe(22);
    const second = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/reviews`)
      .query({ before: first.body.nextBefore })
      .expect(200);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextBefore).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(22);

    // Task 380: the filter by stars pages the same way; 22 reviews of 1…5 stars in turn.
    expect(first.body.stars).toEqual([5, 5, 4, 4, 4]);
    const ones = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/reviews`)
      .query({ rating: 1 })
      .expect(200);
    expect(ones.body.items).toHaveLength(5);
    expect(ones.body.items.every((r: { rating: number }) => r.rating === 1)).toBe(true);
    expect(ones.body.nextBefore).toBeNull();
  });

  it('the cabinet: with the client name; staff see only their own visits', async () => {
    await switchOn();
    const a = await book(10, kasiaId);
    const c = await book(12, olaId, BOB);
    await tookPlace(a.id, 1);
    await tookPlace(c.id, 1);
    await review(a.token, { rating: 5 });
    await review(c.token, { rating: 3 });

    const all = await ctx.http().get(`${base}/reviews`).set(owner.auth).expect(200);
    // Task 383: each specialist with reviews, for the chips; the filter by one of them.
    expect(all.body.staff).toEqual([
      { staffId: kasiaId, displayName: 'Kasia', count: 1, average: 5 },
      { staffId: olaId, displayName: 'Ola', count: 1, average: 3 },
    ]);
    const olas = await ctx
      .http()
      .get(`${base}/reviews`)
      .query({ staffId: olaId })
      .set(owner.auth)
      .expect(200);
    expect(olas.body).toMatchObject({ count: 1, average: 3, stars: [0, 0, 1, 0, 0] });
    expect(olas.body.staff).toHaveLength(2);
    expect(olas.body.items.map((r: { staffName: string }) => r.staffName)).toEqual(['Ola']);
    expect(all.body).toMatchObject({ enabled: true, count: 2, average: 4, stars: [0, 0, 1, 0, 1] });
    // Task 380: the salon looks for its lower ratings.
    const threes = await ctx.http().get(`${base}/reviews`).query({ rating: 3 }).set(owner.auth);
    expect(threes.status).toBe(200);
    expect(threes.body.items.map((r: { appointmentId: string }) => r.appointmentId)).toEqual([
      c.id,
    ]);
    expect(all.body.items[0]).toMatchObject({
      rating: 3,
      staffName: 'Ola',
      customerName: 'Bob Nowak',
      appointmentId: c.id,
      serviceName: 'Strzyżenie',
    });

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
      where: { id: kasiaId },
      data: { userId: kasia.userId },
    });
    const own = await ctx.http().get(`${base}/reviews`).set(kasia.auth).expect(200);
    expect(own.body.count).toBe(1);
    // Staff with only their own visits count only their own stars.
    expect(own.body.stars).toEqual([0, 0, 0, 0, 1]);
    // Task 383: and see only themselves among the specialists.
    expect(own.body.staff).toEqual([
      { staffId: kasiaId, displayName: 'Kasia', count: 1, average: 5 },
    ]);
    expect(own.body.items).toEqual([
      expect.objectContaining({ appointmentId: a.id, customerName: 'Anna Kowalska' }),
    ]);

    // An anonymised client's review stays, without the name.
    const annaCard = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    await ctx.prisma.customer.update({
      where: { id: annaCard.customerId! },
      data: { anonymizedAt: new Date() },
    });
    const after = await ctx.http().get(`${base}/reviews`).set(owner.auth).expect(200);
    expect(after.body.items[1]).toMatchObject({ customerId: null, customerName: null });
  });
});

describe('the salon answers a review (task 211)', () => {
  async function reviewed() {
    await switchOn();
    const visit = await book(10, kasiaId);
    await tookPlace(visit.id, 1);
    await review(visit.token, { rating: 4, text: 'Dobrze' });
    const list = await ctx.http().get(`${base}/reviews`).set(owner.auth).expect(200);
    return { visit, reviewId: list.body.items[0].id as string };
  }

  it('the answer is shown on the salon page and to the client; changed or removed; logged', async () => {
    const { visit, reviewId } = await reviewed();
    const before = await ctx.prisma.visitReview.findUniqueOrThrow({ where: { id: reviewId } });
    // Task 382: "Bez odpowiedzi" — the review waits for an answer.
    const waiting = await ctx
      .http()
      .get(`${base}/reviews`)
      .query({ unanswered: 'true' })
      .set(owner.auth)
      .expect(200);
    expect(waiting.body.unanswered).toBe(1);
    expect(waiting.body.items.map((r: { id: string }) => r.id)).toEqual([reviewId]);

    const answered = await ctx
      .http()
      .put(`${base}/reviews/${reviewId}/reply`)
      .set(owner.auth)
      .send({ text: '  Dziękujemy, do zobaczenia!  ' })
      .expect(200);
    expect(answered.body).toMatchObject({
      id: reviewId,
      rating: 4,
      customerName: 'Anna Kowalska',
      reply: 'Dziękujemy, do zobaczenia!',
    });
    expect(answered.body.repliedAt).toEqual(expect.any(String));
    // The review's "changed" time stays the client's.
    expect(answered.body.updatedAt).toBe(before.updatedAt.toISOString());

    const page = await ctx.http().get(`/v1/public/locations/${slug}/reviews`).expect(200);
    expect(page.body.items[0]).toMatchObject({ reply: 'Dziękujemy, do zobaczenia!' });
    // Task 382: answered — no longer under "Bez odpowiedzi"; the whole list still has it.
    const answeredList = await ctx
      .http()
      .get(`${base}/reviews`)
      .query({ unanswered: 'true' })
      .set(owner.auth)
      .expect(200);
    expect(answeredList.body).toMatchObject({ unanswered: 0, count: 1, items: [] });
    const whole = await ctx
      .http()
      .get(`${base}/reviews`)
      .query({ unanswered: 'false' })
      .set(owner.auth)
      .expect(200);
    expect(whole.body.items).toHaveLength(1);
    await ctx
      .http()
      .get(`${base}/reviews`)
      .query({ unanswered: 'yes' })
      .set(owner.auth)
      .expect(400);

    const mine = await ctx.http().get(`/v1/public/appointments/${visit.token}/review`).expect(200);
    expect(mine.body.review).toMatchObject({ rating: 4, reply: 'Dziękujemy, do zobaczenia!' });

    // Writing again changes it; the client changing the review keeps it.
    await ctx
      .http()
      .put(`${base}/reviews/${reviewId}/reply`)
      .set(owner.auth)
      .send({ text: 'Dziękujemy!' })
      .expect(200);
    const changed = await review(visit.token, { rating: 5, text: 'Jednak super' });
    expect(changed.body.review).toMatchObject({ rating: 5, reply: 'Dziękujemy!' });

    expectError(
      (
        await ctx
          .http()
          .put(`${base}/reviews/${reviewId}/reply`)
          .set(owner.auth)
          .send({ text: '   ' })
          .expect(400)
      ).body,
      'VALIDATION_ERROR',
    );
    await ctx
      .http()
      .put(`${base}/reviews/${reviewId}/reply`)
      .set(owner.auth)
      .send({ text: 'x'.repeat(1001) })
      .expect(400);

    const removed = await ctx
      .http()
      .delete(`${base}/reviews/${reviewId}/reply`)
      .set(owner.auth)
      .expect(200);
    expect(removed.body).toMatchObject({ reply: null, repliedAt: null, rating: 5 });
    const gone = await ctx.http().get(`/v1/public/locations/${slug}/reviews`).expect(200);
    expect(gone.body.items[0]).toMatchObject({ reply: null, repliedAt: null });
    const again = await ctx.http().get(`${base}/reviews`).set(owner.auth).expect(200);
    expect(again.body.unanswered).toBe(1);

    const log = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'review', entityId: reviewId },
      orderBy: { id: 'asc' },
    });
    expect(log.map((l) => l.action)).toEqual([
      'review.reply_set',
      'review.reply_set',
      'review.reply_removed',
    ]);
    // The answer's words are not kept in the log.
    expect(JSON.stringify(log)).not.toContain('Dziękujemy');
  });

  it('only owners and managers of the salon; another salon’s review is 404', async () => {
    const { reviewId } = await reviewed();
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        permissionOverrides: { viewAllAppointments: true },
        locations: { create: [{ locationId }] },
      },
    });
    await ctx
      .http()
      .put(`${base}/reviews/${reviewId}/reply`)
      .set(kasia.auth)
      .send({ text: 'Dzięki' })
      .expect(403);
    await ctx.http().delete(`${base}/reviews/${reviewId}/reply`).set(kasia.auth).expect(403);

    const other = await signUp(ctx, 'other@example.com');
    const theirs = await createOrgWithLocation(ctx, other, 'Other');
    const theirBase = `/v1/organizations/${theirs.orgId}/locations/${theirs.locationId}`;
    await ctx
      .http()
      .put(`${theirBase}/reviews/${reviewId}/reply`)
      .set(other.auth)
      .send({ text: 'Hack' })
      .expect(404);
    await ctx
      .http()
      .put(`${base}/reviews/00000000-0000-7000-8000-000000000000/reply`)
      .set(owner.auth)
      .send({ text: 'Nic' })
      .expect(404);
    await ctx
      .http()
      .put(`${base}/reviews/not-a-uuid/reply`)
      .set(owner.auth)
      .send({ text: 'Nic' })
      .expect(404);
    const kept = await ctx.prisma.visitReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(kept.reply).toBeNull();
  });
});
