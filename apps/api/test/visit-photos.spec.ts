import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VisitPhotosService } from '../src/booking/visit-photos.service';
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

/** Task 80b: "Pokaż, co chcesz" — the client's example photos for a visit. */

const TZ = 'Europe/Warsaw';
const CLIENT = {
  name: 'Anna Kowalska',
  phone: '+48 600 100 200',
  email: 'anna.client@example.com',
  locale: 'pl',
  acceptTerms: true,
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const DAY_MS = 86_400_000;

let ctx: TestContext;
let photos: VisitPhotosService;
let owner: SignedInUser;
let slug: string;
let base: string;
let serviceId: string;
let staffId: string;
let day: string;

beforeAll(async () => {
  ctx = await createTestApp();
  photos = ctx.app.get(VisitPhotosService);
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
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
    .expect(201);
  expect(service.body.wishPhotos).toBe(false);
  serviceId = service.body.id;
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
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

async function askPhotos(on: boolean) {
  const svc = await ctx.http().get(`${base}/services/${serviceId}`).set(owner.auth).expect(200);
  return ctx
    .http()
    .patch(`${base}/services/${serviceId}`)
    .set(owner.auth)
    .send({ version: svc.body.version, wishPhotos: on })
    .expect(200);
}

const at = (hh: number) => new Date(zonedToInstant(day, hh * 60, TZ)).toISOString();

async function hold(hh: number): Promise<{ holdId: string; holdToken: string }> {
  const h = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start: at(hh) })
    .expect(201);
  return h.body;
}

const upload = (h: { holdId: string; holdToken: string }, bytes: Buffer, type = 'image/png') =>
  ctx
    .http()
    .post(`/v1/public/holds/${h.holdId}/photos`)
    .set('X-Hold-Token', h.holdToken)
    .set('Content-Type', type)
    .send(bytes);

async function confirm(h: { holdId: string; holdToken: string }) {
  await ctx
    .http()
    .post(`/v1/public/holds/${h.holdId}/code`)
    .send({ holdToken: h.holdToken, ...CLIENT })
    .expect(202);
  const code = ctx.mail.lastTo(CLIENT.email)?.text.match(/\b(\d{6})\b/)?.[1];
  const c = await ctx
    .http()
    .post(`/v1/public/holds/${h.holdId}/confirm`)
    .send({ holdToken: h.holdToken, code })
    .expect(200);
  return c.body as { appointment: { id: string }; manageToken: string };
}

describe('visit photos', () => {
  it('only for services where the salon asks; the booking page says which', async () => {
    const h = await hold(10);
    expectError((await upload(h, PNG).expect(409)).body, 'PHOTOS_NOT_ASKED');
    const saved = await askPhotos(true);
    expect(saved.body.wishPhotos).toBe(true);
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.services[0].wishPhotos).toBe(true);
    await upload(h, PNG).expect(201);
  });

  it('up to 3 pictures on the hold, with its token; the visit gets them', async () => {
    await askPhotos(true);
    const h = await hold(10);
    // Without or with a wrong token: no such hold.
    await ctx
      .http()
      .post(`/v1/public/holds/${h.holdId}/photos`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(404);
    await upload({ ...h, holdToken: 'x'.repeat(43) }, PNG).expect(404);
    // Only real pictures.
    expectError(
      (await upload(h, Buffer.from('<svg></svg>'), 'image/svg+xml').expect(415)).body,
      'UNSUPPORTED_PHOTO',
    );
    const first = await upload(h, PNG).expect(201);
    expect(first.body).toMatchObject({ contentType: 'image/png', sizeBytes: PNG.length });
    expect(first.body.url).toMatch(
      /^\/v1\/public\/visit-photos\/[\w-]+\?exp=\d+&sig=[0-9a-f]{64}$/,
    );
    await upload(h, JPEG, 'image/jpeg').expect(201);
    const third = await upload(h, PNG).expect(201);
    expectError((await upload(h, PNG).expect(409)).body, 'TOO_MANY_PHOTOS');
    // The client takes one back.
    await ctx
      .http()
      .delete(`/v1/public/holds/${h.holdId}/photos/${third.body.id}`)
      .set('X-Hold-Token', h.holdToken)
      .expect(204);
    const listed = await ctx
      .http()
      .get(`/v1/public/holds/${h.holdId}/photos`)
      .set('X-Hold-Token', h.holdToken)
      .expect(200);
    expect(listed.body.items.map((p: { contentType: string }) => p.contentType)).toEqual([
      'image/png',
      'image/jpeg',
    ]);
    expect(listed.body.deleteAfter).toBeNull();

    // The signed link shows the picture; a changed or expired link does not.
    const picture = await ctx.http().get(first.body.url).expect(200);
    expect(picture.headers['content-type']).toBe('image/png');
    expect(Buffer.from(picture.body as Buffer)).toEqual(PNG);
    await ctx.http().get(first.body.url.replace(/sig=./, 'sig=0')).expect(404);
    const expired = photos.signedUrl(first.body.id, Date.now() - 2 * 60 * 60_000);
    await ctx.http().get(expired).expect(404);
    await ctx.http().get(`/v1/public/visit-photos/${first.body.id}`).expect(404);

    // Confirmed: the salon sees them; the client sees them by the visit link.
    const booked = await confirm(h);
    const forSalon = await ctx
      .http()
      .get(`${base}/appointments/${booked.appointment.id}/photos`)
      .set(owner.auth)
      .expect(200);
    expect(forSalon.body.items).toHaveLength(2);
    const end = new Date(zonedToInstant(day, 10 * 60 + 30, TZ)).getTime();
    expect(forSalon.body.deleteAfter).toBe(new Date(end + 90 * DAY_MS).toISOString());
    await ctx.http().get(forSalon.body.items[1].url).expect(200);
    // The hold's steps are over.
    await upload(h, PNG).expect(404);

    const byLink = await ctx
      .http()
      .get(`/v1/public/appointments/${booked.manageToken}/photos`)
      .expect(200);
    expect(byLink.body.items).toHaveLength(2);
    await ctx
      .http()
      .delete(`/v1/public/appointments/${booked.manageToken}/photos/${byLink.body.items[0].id}`)
      .expect(204);
    await ctx
      .http()
      .delete(`/v1/public/appointments/${booked.manageToken}/photos/${byLink.body.items[0].id}`)
      .expect(404);
    expect(
      (
        await ctx
          .http()
          .get(`${base}/appointments/${booked.appointment.id}/photos`)
          .set(owner.auth)
          .expect(200)
      ).body.items,
    ).toHaveLength(1);

    // Another salon cannot see them.
    const other = await signUp(ctx, 'other@example.com');
    const otherOrg = await createOrgWithLocation(ctx, other, 'Inny');
    await ctx
      .http()
      .get(
        `/v1/organizations/${otherOrg.orgId}/locations/${otherOrg.locationId}/appointments/${booked.appointment.id}/photos`,
      )
      .set(other.auth)
      .expect(404);
    await ctx
      .http()
      .get(`${base}/appointments/${booked.appointment.id}/photos`)
      .set(other.auth)
      .expect(404);
  });

  it('deleted 90 days after the visit, at once for lapsed holds and cancelled visits', async () => {
    await askPhotos(true);
    const kept = await hold(10);
    await upload(kept, PNG).expect(201);
    const booked = await confirm(kept);
    const lapsed = await hold(12);
    await upload(lapsed, PNG).expect(201);
    const cancelled = await hold(14);
    await upload(cancelled, JPEG, 'image/jpeg').expect(201);
    const gone = await confirm(cancelled);
    await ctx
      .http()
      .post(`/v1/public/appointments/${gone.manageToken}/cancel`)
      .send({})
      .expect(200);

    // Nothing is due yet except the cancelled visit's photo.
    expect(await photos.purge()).toBe(1);
    // The hold lapses after 10 minutes.
    expect(await photos.purge(Date.now() + 11 * 60_000)).toBe(1);
    expect(await ctx.prisma.visitPhoto.count()).toBe(1);
    // 90 days after the visit.
    const end = new Date(zonedToInstant(day, 10 * 60 + 30, TZ)).getTime();
    expect(await photos.purge(end + 89 * DAY_MS)).toBe(0);
    expect(await photos.purge(end + 91 * DAY_MS)).toBe(1);
    expect(
      (await ctx.http().get(`/v1/public/appointments/${booked.manageToken}/photos`).expect(200))
        .body.items,
    ).toEqual([]);
  });
});
