import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

// Task 254: the owner sets the order of the price-list categories once (the most popular
// first), and clients see the groups in it on the booking page and in the apps.

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@category-order.test');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Kolejka Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
});

async function addCategory(name: string, at = base, user = owner): Promise<string> {
  const res = await ctx
    .http()
    .post(`${at}/service-categories`)
    .set(user.auth)
    .send({ name })
    .expect(201);
  return res.body.id as string;
}

async function addService(name: string, categoryId: string): Promise<string> {
  const res = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name, durationMinutes: 30, priceGrosze: 5000, categoryId })
    .expect(201);
  return res.body.id as string;
}

const names = (body: { name: string }[]) => body.map((s) => s.name);
const order = (categoryIds: string[], user = owner, at = base) =>
  ctx.http().put(`${at}/service-categories/order`).set(user.auth).send({ categoryIds });
const list = async () =>
  names((await ctx.http().get(`${base}/service-categories`).set(owner.auth).expect(200)).body);

/** Invites `email` with `role`, signs them up and accepts. */
async function join(email: string, role: 'staff' | 'manager', staffMemberId?: string) {
  await ctx
    .http()
    .post(`/v1/organizations/${orgId}/invitations`)
    .set(owner.auth)
    .send({ email, role, locationIds: [locationId], ...(staffMemberId ? { staffMemberId } : {}) })
    .expect(201);
  const token = ctx.mail.lastTo(email)?.text.match(/\/invite\/(\S+)/)?.[1];
  if (!token) throw new Error(`no invitation sent to ${email}`);
  const user = await signUp(ctx, email, email.split('@')[0]);
  await ctx.http().post(`/v1/invitations/${token}/accept`).set(user.auth).expect(200);
  return user;
}

describe('the order of the categories', () => {
  it('the owner puts "Broda" first — the list and the booking page follow', async () => {
    const hair = await addCategory('Włosy');
    const beard = await addCategory('Broda');
    const kids = await addCategory('Dzieci');
    const services = [
      await addService('Strzyżenie', hair),
      await addService('Trymowanie', beard),
      await addService('Strzyżenie dziecka', kids),
    ];
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: services })
      .expect(201);

    const res = await order([beard, kids, hair]).expect(200);
    expect(names(res.body)).toEqual(['Broda', 'Dzieci', 'Włosy']);
    expect(res.body.map((c: { sortOrder: number }) => c.sortOrder)).toEqual([0, 10, 20]);
    expect(await list()).toEqual(['Broda', 'Dzieci', 'Włosy']);

    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(200);
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(names(page.body.categories)).toEqual(['Broda', 'Dzieci', 'Włosy']);

    const logged = await ctx.prisma.auditLog.count({
      where: { action: 'service_category.reordered', entityId: locationId },
    });
    expect(logged).toBe(1);
  });

  it('a new category goes to the end of the order the owner set', async () => {
    const hair = await addCategory('Włosy');
    const beard = await addCategory('Broda');
    await order([hair, beard]).expect(200);
    await addCategory('Afro');
    expect(await list()).toEqual(['Włosy', 'Broda', 'Afro']);
  });

  it('a moved category gets a new version, so an old rename form cannot undo the order', async () => {
    const hair = await addCategory('Włosy');
    const beard = await addCategory('Broda');
    const before = (await ctx.http().get(`${base}/service-categories`).set(owner.auth)).body as {
      id: string;
      version: number;
    }[];
    const hairBefore = before.find((c) => c.id === hair)!;
    const beardBefore = before.find((c) => c.id === beard)!;
    // Both had sortOrder 0 (Broda first by name): Broda keeps 0 and its version; Włosy moves.
    await order([beard, hair]).expect(200);
    const after = (await ctx.http().get(`${base}/service-categories`).set(owner.auth)).body as {
      id: string;
      version: number;
    }[];
    expect(after.find((c) => c.id === beard)!.version).toBe(beardBefore.version);
    const stale = await ctx
      .http()
      .patch(`${base}/service-categories/${hair}`)
      .set(owner.auth)
      .send({ version: hairBefore.version, name: 'Fryzury' })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');
  });

  it('the list must name every category of the location exactly once', async () => {
    const hair = await addCategory('Włosy');
    const beard = await addCategory('Broda');
    expectError((await order([hair]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([hair, beard, hair]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([]).expect(400)).body, 'VALIDATION_ERROR');

    // A category of another salon cannot be slipped in.
    const other = await signUp(ctx, 'other@category-order.test');
    const elsewhere = await createOrgWithLocation(ctx, other, 'Inny Salon');
    const otherBase = `/v1/organizations/${elsewhere.orgId}/locations/${elsewhere.locationId}`;
    const stranger = await addCategory('Obca', otherBase, other);
    expectError((await order([hair, stranger]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([beard, hair, stranger]).expect(400)).body, 'VALIDATION_ERROR');
    expect(await list()).toEqual(['Broda', 'Włosy']);

    // And the other salon's owner cannot reorder this one.
    await order([beard, hair], other).expect(404);
  });

  it('a manager may set the order; a specialist may not', async () => {
    const hair = await addCategory('Włosy');
    const beard = await addCategory('Broda');
    const manager = await join('manager@category-order.test', 'manager');
    await order([hair, beard], manager).expect(200);
    const kasia = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia' })
      .expect(201);
    const specialist = await join('kasia@category-order.test', 'staff', kasia.body.id as string);
    expectError((await order([beard, hair], specialist).expect(403)).body, 'FORBIDDEN');
    expect(await list()).toEqual(['Włosy', 'Broda']);
  });
});
