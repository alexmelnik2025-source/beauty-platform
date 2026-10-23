import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

let ctx: TestContext;
let owner: SignedInUser;
let kasia: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let serviceId: string;
let kasiaStaffId: string;
let olaStaffId: string;
let kasiaMembershipId: string;
let day: string;

const at = (hh: number, mm = 0): string =>
  new Date(zonedToInstant(day, hh * 60 + mm, TZ)).toISOString();

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  const staffIds: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
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
  [kasiaStaffId, olaStaffId] = staffIds as [string, string];

  kasia = await signUp(ctx, 'kasia@example.com');
  const membership = await ctx.prisma.membership.create({
    data: {
      userId: kasia.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
  kasiaMembershipId = membership.id;
  await ctx.prisma.staffMember.update({
    where: { id: kasiaStaffId },
    data: { userId: kasia.userId },
  });
  day = addDays(localToday(Date.now(), TZ), 3);
});

// ── Helpers ───────────────────────────────────────────

const book = (staffId: string, hh: number, auth = owner.auth, extra: object = {}) =>
  ctx
    .http()
    .post(`${base}/appointments`)
    .set(auth)
    .send({
      serviceId,
      staffId,
      start: at(hh),
      customer: { name: 'Jan Nowak', phone: '+48600000002', email: 'jan@example.com' },
      ...extra,
    });

const calendar = (auth = kasia.auth) =>
  ctx.http().get(`${base}/appointments`).query({ from: day, to: day }).set(auth);

async function memberVersion(): Promise<number> {
  const row = await ctx.prisma.membership.findUniqueOrThrow({ where: { id: kasiaMembershipId } });
  return row.version;
}

/** Sets Kasia's category and exceptions as the owner (expects 200). */
async function setKasia(staffCategoryId: string | null, overrides: object = {}) {
  return ctx
    .http()
    .put(`/v1/organizations/${orgId}/members/${kasiaMembershipId}/permissions`)
    .set(owner.auth)
    .send({ version: await memberVersion(), staffCategoryId, overrides })
    .expect(200);
}

const createCategory = (name: string, permissions: object) =>
  ctx
    .http()
    .post(`/v1/organizations/${orgId}/staff-categories`)
    .set(owner.auth)
    .send({ name, permissions });

// ── Tests ─────────────────────────────────────────────

describe('defaults for a staff member', () => {
  it('sees own appointments with the client name, but no contacts and no price', async () => {
    await book(kasiaStaffId, 10).expect(201);
    await book(olaStaffId, 10).expect(201);
    const res = await calendar().expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      staff: { id: kasiaStaffId },
      service: { name: 'Strzyżenie' },
      customer: { name: 'Jan Nowak', phone: null, email: null },
      priceGrosze: null,
      status: 'confirmed',
    });
    // The owner still sees everything.
    const all = await calendar(owner.auth).expect(200);
    expect(all.body).toHaveLength(2);
    expect(all.body[0].customer.phone).toBe('+48600000002');
    expect(all.body[0].priceGrosze).toBe(8000);
  });

  it('may create, move and cancel own appointments, nothing else', async () => {
    const own = await book(kasiaStaffId, 10, kasia.auth).expect(201);
    await ctx
      .http()
      .post(`${base}/appointments/${own.body.id}/reschedule`)
      .set(kasia.auth)
      .send({ version: 1, start: at(12) })
      .expect(200);
    await ctx
      .http()
      .post(`${base}/appointments/${own.body.id}/cancel`)
      .set(kasia.auth)
      .send({ version: 2, reason: 'Klient prosił' })
      .expect(200);

    expectError((await book(olaStaffId, 14, kasia.auth).expect(403)).body, 'FORBIDDEN');
    const ola = await book(olaStaffId, 15).expect(201);
    await ctx.http().get(`${base}/appointments/${ola.body.id}`).set(kasia.auth).expect(404);
    // Moving own appointment to another staff member is acting for them.
    const mine = await book(kasiaStaffId, 16, kasia.auth).expect(201);
    await ctx
      .http()
      .post(`${base}/appointments/${mine.body.id}/reschedule`)
      .set(kasia.auth)
      .send({ version: 1, start: at(16), staffId: olaStaffId })
      .expect(403);
  });

  it('may not book outside working hours', async () => {
    await book(kasiaStaffId, 20, kasia.auth, { allowOutsideHours: true }).expect(403);
  });

  it('may not manage categories or see the member list', async () => {
    await ctx.http().get(`/v1/organizations/${orgId}/members`).set(kasia.auth).expect(403);
    await ctx
      .http()
      .post(`/v1/organizations/${orgId}/staff-categories`)
      .set(kasia.auth)
      .send({ name: 'Me' })
      .expect(403);
  });

  it('the catalog tells the interface what the caller may do', async () => {
    const mine = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/permissions`)
      .set(kasia.auth)
      .expect(200);
    expect(mine.body.me).toMatchObject({
      role: 'staff',
      permissions: { createOwnAppointments: true, viewClientContacts: false },
    });
    expect(mine.body.permissions).toContainEqual({ key: 'viewClientContacts', default: false });
    const owners = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/permissions`)
      .set(owner.auth)
      .expect(200);
    expect(Object.values(owners.body.me.permissions).every(Boolean)).toBe(true);
  });
});

describe('categories and personal exceptions', () => {
  it('a category grants, a personal exception overrides it, effective on the next request', async () => {
    await book(kasiaStaffId, 10).expect(201);
    const senior = await createCategory('Senior', {
      viewClientContacts: true,
      viewOwnEarnings: true,
    }).expect(201);

    await setKasia(senior.body.id);
    let res = await calendar().expect(200);
    expect(res.body[0].customer.phone).toBe('+48600000002');
    expect(res.body[0].priceGrosze).toBe(8000);

    const member = await setKasia(senior.body.id, { viewClientContacts: false });
    expect(member.body.permissions).toMatchObject({
      viewClientContacts: false,
      viewOwnEarnings: true,
    });
    res = await calendar().expect(200);
    expect(res.body[0].customer.phone).toBeNull();
    expect(res.body[0].priceGrosze).toBe(8000);
  });

  it('a personal exception can also grant what the category denies', async () => {
    const trainee = await createCategory('Trainee', { createOwnAppointments: false }).expect(201);
    await setKasia(trainee.body.id);
    await book(kasiaStaffId, 10, kasia.auth).expect(403);
    await setKasia(trainee.body.id, { createOwnAppointments: true });
    await book(kasiaStaffId, 10, kasia.auth).expect(201);
  });

  it('viewing all appointments does not allow changing them', async () => {
    const ola = await book(olaStaffId, 10).expect(201);
    await setKasia(null, { viewAllAppointments: true });
    const res = await calendar().expect(200);
    expect(res.body.map((a: { id: string }) => a.id)).toEqual([ola.body.id]);
    await ctx
      .http()
      .post(`${base}/appointments/${ola.body.id}/cancel`)
      .set(kasia.auth)
      .send({ version: 1, reason: 'x' })
      .expect(403);
    await setKasia(null, { viewAllAppointments: true, manageAllAppointments: true });
    await ctx
      .http()
      .post(`${base}/appointments/${ola.body.id}/cancel`)
      .set(kasia.auth)
      .send({ version: 1, reason: 'Recepcja' })
      .expect(200);
  });

  it('turning off "change own appointments" blocks cancel and move', async () => {
    const own = await book(kasiaStaffId, 10, kasia.auth).expect(201);
    await setKasia(null, { changeOwnAppointments: false });
    await ctx
      .http()
      .post(`${base}/appointments/${own.body.id}/cancel`)
      .set(kasia.auth)
      .send({ version: 1, reason: 'x' })
      .expect(403);
  });

  it('deleting a category returns its members to the defaults', async () => {
    await book(kasiaStaffId, 10).expect(201);
    const senior = await createCategory('Senior', { viewClientContacts: true }).expect(201);
    await setKasia(senior.body.id);
    await ctx
      .http()
      .delete(`/v1/organizations/${orgId}/staff-categories/${senior.body.id}`)
      .set(owner.auth)
      .expect(204);
    const res = await calendar().expect(200);
    expect(res.body[0].customer.phone).toBeNull();
    const members = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/members`)
      .set(owner.auth)
      .expect(200);
    const k = members.body.find(
      (x: { membershipId: string }) => x.membershipId === kasiaMembershipId,
    );
    expect(k.staffCategoryId).toBeNull();
  });

  it('rejects unknown permissions, duplicate names, stale versions and non-staff members', async () => {
    await createCategory('X', { flyToTheMoon: true }).expect(400);
    await createCategory('Senior', {}).expect(201);
    expectError((await createCategory('Senior', {}).expect(409)).body, 'CATEGORY_NAME_TAKEN');

    await setKasia(null, { viewClientContacts: true });
    expectError(
      (
        await ctx
          .http()
          .put(`/v1/organizations/${orgId}/members/${kasiaMembershipId}/permissions`)
          .set(owner.auth)
          .send({ version: 1, staffCategoryId: null, overrides: {} })
          .expect(409)
      ).body,
      'VERSION_CONFLICT',
    );

    const ownerMembership = await ctx.prisma.membership.findFirstOrThrow({
      where: { organizationId: orgId, role: 'owner' },
    });
    expectError(
      (
        await ctx
          .http()
          .put(`/v1/organizations/${orgId}/members/${ownerMembership.id}/permissions`)
          .set(owner.auth)
          .send({ version: 1, staffCategoryId: null, overrides: {} })
          .expect(400)
      ).body,
      'NOT_A_STAFF_MEMBER',
    );
  });

  it('a manager may see categories and members but not change permissions', async () => {
    const manager = await signUp(ctx, 'manager@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: manager.userId,
        organizationId: orgId,
        role: 'manager',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx
      .http()
      .get(`/v1/organizations/${orgId}/staff-categories`)
      .set(manager.auth)
      .expect(200);
    const members = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/members`)
      .set(manager.auth)
      .expect(200);
    expect(members.body).toHaveLength(3);
    await ctx
      .http()
      .put(`/v1/organizations/${orgId}/members/${kasiaMembershipId}/permissions`)
      .set(manager.auth)
      .send({ version: 1, staffCategoryId: null, overrides: { viewClientContacts: true } })
      .expect(403);
  });

  it('every change of permissions is written to the audit log', async () => {
    const senior = await createCategory('Senior', { viewClientContacts: true }).expect(201);
    await setKasia(senior.body.id, { viewOwnEarnings: true });
    const log = await ctx.prisma.auditLog.findMany({
      where: { organizationId: orgId, action: { startsWith: 'staff_category' } },
    });
    expect(log.map((l) => l.action)).toEqual(['staff_category.created']);
    const change = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'membership.permissions_changed', entityId: kasiaMembershipId },
    });
    expect(change.actorUserId).toBe(owner.userId);
    expect(change.metadata).toMatchObject({
      staffCategoryId: senior.body.id,
      overrides: { viewOwnEarnings: true },
    });
  });
});
