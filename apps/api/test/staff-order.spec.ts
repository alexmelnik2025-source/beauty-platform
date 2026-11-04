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

// Task 13 (6-month plan: in Booksy the owner could not put the right barber first): the owner
// sets the order of the staff once, and clients see it on the booking page and in the apps.

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
  owner = await signUp(ctx, 'owner@staff-order.test');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Kolejka Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
});

async function addStaff(displayName: string, at = base, user = owner): Promise<string> {
  const res = await ctx.http().post(`${at}/staff`).set(user.auth).send({ displayName }).expect(201);
  return res.body.id as string;
}

const names = (body: { displayName: string }[]) => body.map((s) => s.displayName);
const order = (staffIds: string[], user = owner, at = base) =>
  ctx.http().put(`${at}/staff/order`).set(user.auth).send({ staffIds });

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

describe('the order of the staff', () => {
  it('the owner puts Ola first — the list, the booking page and the calendar follow', async () => {
    const kasia = await addStaff('Kasia');
    const alex = await addStaff('Alex');
    const ola = await addStaff('Ola');
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({
        name: 'Strzyżenie',
        durationMinutes: 30,
        priceGrosze: 7000,
        staffIds: [kasia, alex, ola],
      })
      .expect(201);
    expect(service.body.id).toBeTruthy();

    const res = await order([ola, kasia, alex]).expect(200);
    expect(names(res.body)).toEqual(['Ola', 'Kasia', 'Alex']);
    expect(res.body.map((s: { sortOrder: number }) => s.sortOrder)).toEqual([0, 10, 20]);

    const list = await ctx.http().get(`${base}/staff`).set(owner.auth).expect(200);
    expect(names(list.body)).toEqual(['Ola', 'Kasia', 'Alex']);

    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(200);
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(names(page.body.staff)).toEqual(['Ola', 'Kasia', 'Alex']);

    // And back again: only the ones that moved change.
    const again = await order([kasia, alex, ola]).expect(200);
    expect(names(again.body)).toEqual(['Kasia', 'Alex', 'Ola']);
  });

  it('a moved staff member gets a new version, so an old edit form cannot undo the order', async () => {
    const kasia = await addStaff('Kasia');
    const ola = await addStaff('Ola');
    const before = await ctx.http().get(`${base}/staff/${ola}`).set(owner.auth).expect(200);
    await order([ola, kasia]).expect(200);
    const stale = await ctx
      .http()
      .patch(`${base}/staff/${ola}`)
      .set(owner.auth)
      .send({ version: before.body.version, bio: 'Barber' })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');
  });

  it('the list must name every staff member of the location exactly once', async () => {
    const kasia = await addStaff('Kasia');
    const ola = await addStaff('Ola');
    expectError((await order([kasia]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([kasia, ola, kasia]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([]).expect(400)).body, 'VALIDATION_ERROR');

    // Someone from another salon cannot be slipped in.
    const other = await signUp(ctx, 'other@staff-order.test');
    const elsewhere = await createOrgWithLocation(ctx, other, 'Inny Salon');
    const otherBase = `/v1/organizations/${elsewhere.orgId}/locations/${elsewhere.locationId}`;
    const stranger = await addStaff('Obcy', otherBase, other);
    expectError((await order([kasia, stranger]).expect(400)).body, 'VALIDATION_ERROR');
    expectError((await order([kasia, ola, stranger]).expect(400)).body, 'VALIDATION_ERROR');

    // Nothing changed.
    const list = await ctx.http().get(`${base}/staff`).set(owner.auth).expect(200);
    expect(names(list.body)).toEqual(['Kasia', 'Ola']);

    // And the other salon's owner cannot reorder this one.
    await order([ola, kasia], other).expect(404);
  });

  it('a manager may set the order; a specialist may not', async () => {
    const kasia = await addStaff('Kasia');
    const ola = await addStaff('Ola');
    const manager = await join('manager@staff-order.test', 'manager');
    await order([ola, kasia], manager).expect(200);
    const specialist = await join('kasia@staff-order.test', 'staff', kasia);
    expectError((await order([kasia, ola], specialist).expect(403)).body, 'FORBIDDEN');
    const list = await ctx.http().get(`${base}/staff`).set(owner.auth).expect(200);
    expect(names(list.body)).toEqual(['Ola', 'Kasia']);
  });
});
