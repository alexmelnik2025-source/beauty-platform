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

// Task 252: the owner sets the order of the services once (the most popular first), and
// clients see the price list in it on the booking page and in the apps.

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
  owner = await signUp(ctx, 'owner@service-order.test');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Kolejka Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
});

async function addService(name: string, at = base, user = owner): Promise<string> {
  const res = await ctx
    .http()
    .post(`${at}/services`)
    .set(user.auth)
    .send({ name, durationMinutes: 30, priceGrosze: 5000 })
    .expect(201);
  return res.body.id as string;
}

const names = (body: { name: string }[]) => body.map((s) => s.name);
const order = (serviceIds: string[], user = owner, at = base) =>
  ctx.http().put(`${at}/services/order`).set(user.auth).send({ serviceIds });
const list = async () =>
  names((await ctx.http().get(`${base}/services`).set(owner.auth).expect(200)).body);

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

describe('the order of the services', () => {
  it('the owner puts the beard first — the list and the booking page follow', async () => {
    const haircut = await addService('Strzyżenie');
    const beard = await addService('Broda');
    const combo = await addService('Strzyżenie + broda');
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [haircut, beard, combo] })
      .expect(201);
    expect(staff.body.id).toBeTruthy();

    const res = await order([beard, combo, haircut]).expect(200);
    expect(names(res.body)).toEqual(['Broda', 'Strzyżenie + broda', 'Strzyżenie']);
    expect(res.body.map((s: { sortOrder: number }) => s.sortOrder)).toEqual([0, 10, 20]);
    expect(await list()).toEqual(['Broda', 'Strzyżenie + broda', 'Strzyżenie']);

    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(200);
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(names(page.body.services)).toEqual(['Broda', 'Strzyżenie + broda', 'Strzyżenie']);

    const logged = await ctx.prisma.auditLog.count({
      where: { action: 'service.reordered', entityId: locationId },
    });
    expect(logged).toBe(1);
  });

  it('a new service goes to the end of the order the owner set', async () => {
    const haircut = await addService('Strzyżenie');
    const beard = await addService('Broda');
    await order([beard, haircut]).expect(200);
    await addService('Golenie');
    expect(await list()).toEqual(['Broda', 'Strzyżenie', 'Golenie']);
  });

  it('a moved service gets a new version, so an old edit form cannot undo the order', async () => {
    const haircut = await addService('Strzyżenie');
    const beard = await addService('Broda');
    const before = await ctx.http().get(`${base}/services/${haircut}`).set(owner.auth).expect(200);
    const beardBefore = await ctx.http().get(`${base}/services/${beard}`).set(owner.auth);
    await order([beard, haircut]).expect(200);
    // Both had sortOrder 0: the beard keeps 0 and its version; the haircut moves to 10.
    const beardAfter = await ctx.http().get(`${base}/services/${beard}`).set(owner.auth);
    expect(beardAfter.body.version).toBe(beardBefore.body.version);
    const stale = await ctx
      .http()
      .patch(`${base}/services/${haircut}`)
      .set(owner.auth)
      .send({ version: before.body.version, sortOrder: 0 })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');
  });

  it('the list must name every service of the location exactly once', async () => {
    const haircut = await addService('Strzyżenie');
    const beard = await addService('Broda');
    expectError((await order([haircut]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([haircut, beard, haircut]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([]).expect(400)).body, 'VALIDATION_ERROR');

    // A service of another salon cannot be slipped in.
    const other = await signUp(ctx, 'other@service-order.test');
    const elsewhere = await createOrgWithLocation(ctx, other, 'Inny Salon');
    const otherBase = `/v1/organizations/${elsewhere.orgId}/locations/${elsewhere.locationId}`;
    const stranger = await addService('Obca usługa', otherBase, other);
    expectError((await order([haircut, stranger]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([beard, haircut, stranger]).expect(400)).body, 'VALIDATION_ERROR');
    expect(await list()).toEqual(['Strzyżenie', 'Broda']);

    // And the other salon's owner cannot reorder this one.
    await order([beard, haircut], other).expect(404);
  });

  it('a manager may set the order; a specialist may not', async () => {
    const haircut = await addService('Strzyżenie');
    const beard = await addService('Broda');
    const manager = await join('manager@service-order.test', 'manager');
    await order([beard, haircut], manager).expect(200);
    const kasia = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia' })
      .expect(201);
    const specialist = await join('kasia@service-order.test', 'staff', kasia.body.id as string);
    expectError((await order([haircut, beard], specialist).expect(403)).body, 'FORBIDDEN');
    expect(await list()).toEqual(['Broda', 'Strzyżenie']);
  });
});
