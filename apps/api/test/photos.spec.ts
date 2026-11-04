import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectImageType, MAX_PHOTO_BYTES } from '../src/scheduling/photos.service';
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

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;

/** Smallest valid-looking files: the right first bytes plus some content. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-body'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);

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
  orgId = org.orgId;
  locationId = org.locationId;
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
});

const upload = (path: string, bytes: Buffer, auth = owner.auth, type = 'image/png') =>
  ctx.http().post(path).set(auth).set('Content-Type', type).send(bytes);

async function addMember(email: string, role: 'staff' | 'manager', at = locationId) {
  const member = await signUp(ctx, email);
  await ctx.prisma.membership.create({
    data: {
      userId: member.userId,
      organizationId: orgId,
      role,
      locations: { create: [{ locationId: at }] },
    },
  });
  return member;
}

async function bookableStaff() {
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
    .expect(201);
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
    .expect(201);
  const current = await ctx.http().get(base).set(owner.auth).expect(200);
  const loc = await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: current.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  return { staffId: staff.body.id as string, slug: loc.body.slug as string };
}

describe('detecting the picture type', () => {
  it('recognises JPEG, PNG and WebP by their first bytes and nothing else', () => {
    expect(detectImageType(JPEG)).toBe('image/jpeg');
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(WEBP)).toBe('image/webp');
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectImageType(Buffer.from('RIFF0000AVI '))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('salon photos', () => {
  it('adds, lists, serves and removes a photo; the booking page shows it', async () => {
    const { slug } = await bookableStaff();
    const added = await upload(`${base}/photos`, PNG).expect(201);
    expect(added.body).toEqual({
      id: expect.any(String),
      url: `/v1/public/photos/${added.body.id}`,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      createdAt: expect.any(String),
    });
    // The type comes from the bytes, not from what the browser claimed.
    const jpeg = await upload(`${base}/photos`, JPEG, owner.auth, 'image/png').expect(201);
    expect(jpeg.body.contentType).toBe('image/jpeg');

    const list = await ctx.http().get(`${base}/photos`).set(owner.auth).expect(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([added.body.id, jpeg.body.id]);
    expect(list.body[0]).not.toHaveProperty('data');

    const file = await ctx.http().get(added.body.url).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);

    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.photos).toEqual([
      { id: added.body.id, url: added.body.url },
      { id: jpeg.body.id, url: jpeg.body.url },
    ]);

    await ctx.http().delete(`${base}/photos/${added.body.id}`).set(owner.auth).expect(204);
    await ctx.http().get(added.body.url).expect(404);
    await ctx.http().delete(`${base}/photos/${added.body.id}`).set(owner.auth).expect(404);
    const after = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(after.body.photos).toEqual([{ id: jpeg.body.id, url: jpeg.body.url }]);
  });

  it('refuses anything that is not a JPEG, PNG or WebP picture', async () => {
    const svg = await upload(
      `${base}/photos`,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      owner.auth,
      'image/svg+xml',
    ).expect(415);
    expectError(svg.body, 'UNSUPPORTED_PHOTO');
    const json = await ctx
      .http()
      .post(`${base}/photos`)
      .set(owner.auth)
      .send({ data: PNG.toString('base64') })
      .expect(415);
    expectError(json.body, 'UNSUPPORTED_PHOTO');
    const empty = await upload(`${base}/photos`, Buffer.alloc(0)).expect(415);
    expectError(empty.body, 'UNSUPPORTED_PHOTO');
    expect(await ctx.prisma.photo.count()).toBe(0);
  });

  it('refuses a photo larger than 3 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_PHOTO_BYTES)]);
    const res = await upload(`${base}/photos`, big).expect(413);
    expectError(res.body, 'PHOTO_TOO_LARGE');
    expect(await ctx.prisma.photo.count()).toBe(0);
  });

  it('keeps at most 10 photos per salon', async () => {
    for (let i = 0; i < 10; i++) await upload(`${base}/photos`, PNG).expect(201);
    const res = await upload(`${base}/photos`, PNG).expect(409);
    expectError(res.body, 'TOO_MANY_PHOTOS');
  });

  it('staff can see the photos but not change them', async () => {
    const added = await upload(`${base}/photos`, PNG).expect(201);
    const member = await addMember('staff@example.com', 'staff');
    await ctx.http().get(`${base}/photos`).set(member.auth).expect(200);
    const res = await upload(`${base}/photos`, PNG, member.auth).expect(403);
    expectError(res.body, 'FORBIDDEN');
    await ctx.http().delete(`${base}/photos/${added.body.id}`).set(member.auth).expect(403);
    expect(await ctx.prisma.photo.count()).toBe(1);
  });

  it('another salon cannot see or remove the photos', async () => {
    const added = await upload(`${base}/photos`, PNG).expect(201);
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Other');
    await ctx.http().get(`${base}/photos`).set(stranger.auth).expect(404);
    await upload(`${base}/photos`, PNG, stranger.auth).expect(404);
    // Its own location, but someone else's photo id.
    await ctx
      .http()
      .delete(
        `/v1/organizations/${other.orgId}/locations/${other.locationId}/photos/${added.body.id}`,
      )
      .set(stranger.auth)
      .expect(404);
    // A manager of another location in the same organization.
    const wola = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({ name: 'Wola', addressLine: 'ul. Wolska 1', city: 'Warszawa', postalCode: '01-001' })
      .expect(201);
    const manager = await addMember('manager@example.com', 'manager', wola.body.id);
    await ctx.http().get(`${base}/photos`).set(manager.auth).expect(404);
    await ctx.http().delete(`${base}/photos/${added.body.id}`).set(manager.auth).expect(404);
    expect(await ctx.prisma.photo.count()).toBe(1);
  });

  it('an unknown or malformed photo link is 404', async () => {
    await ctx.http().get('/v1/public/photos/0b0f6f3e-2f0e-4c39-9d3c-6a1d1b7d9c11').expect(404);
    await ctx.http().get('/v1/public/photos/not-a-uuid').expect(404);
  });
});

describe('staff photos', () => {
  it('sets, replaces and removes the portrait; staff list and booking page show it', async () => {
    const { staffId, slug } = await bookableStaff();
    const path = `${base}/staff/${staffId}/photo`;
    const first = await ctx
      .http()
      .put(path)
      .set(owner.auth)
      .set('Content-Type', 'image/jpeg')
      .send(JPEG)
      .expect(200);
    expect(first.body.contentType).toBe('image/jpeg');

    const staff = await ctx.http().get(`${base}/staff/${staffId}`).set(owner.auth).expect(200);
    expect(staff.body.photoUrl).toBe(first.body.url);
    expect(staff.body).not.toHaveProperty('photo');
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.staff[0].photoUrl).toBe(first.body.url);
    // A portrait is not one of the salon's photos.
    expect(page.body.photos).toEqual([]);

    const second = await ctx
      .http()
      .put(path)
      .set(owner.auth)
      .set('Content-Type', 'image/webp')
      .send(WEBP)
      .expect(200);
    expect(second.body.id).not.toBe(first.body.id);
    await ctx.http().get(first.body.url).expect(404);
    await ctx.http().get(second.body.url).expect(200);
    expect(await ctx.prisma.photo.count()).toBe(1);

    await ctx.http().delete(path).set(owner.auth).expect(204);
    await ctx.http().delete(path).set(owner.auth).expect(404);
    const list = await ctx.http().get(`${base}/staff`).set(owner.auth).expect(200);
    expect(list.body[0].photoUrl).toBeNull();
  });

  it('only owner and manager set portraits, only for their own staff', async () => {
    const { staffId } = await bookableStaff();
    const path = `${base}/staff/${staffId}/photo`;
    const member = await addMember('staff@example.com', 'staff');
    await ctx
      .http()
      .put(path)
      .set(member.auth)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(403);
    const manager = await addMember('manager@example.com', 'manager');
    await ctx
      .http()
      .put(path)
      .set(manager.auth)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(200);

    // A staff member of another salon, addressed through this salon's path.
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Other');
    const foreign = await ctx
      .http()
      .post(`/v1/organizations/${other.orgId}/locations/${other.locationId}/staff`)
      .set(stranger.auth)
      .send({ displayName: 'Obcy' })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${foreign.body.id}/photo`)
      .set(owner.auth)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(404);
    await ctx
      .http()
      .put(`/v1/organizations/${other.orgId}/locations/${other.locationId}/staff/${staffId}/photo`)
      .set(stranger.auth)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(404);
    expect(await ctx.prisma.photo.count()).toBe(1);
  });
});
