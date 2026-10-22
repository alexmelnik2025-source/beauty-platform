import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MembershipRole } from '../src/generated/prisma/client';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LOCATION,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
});

/** Adds `user` to the organization with a role, limited to the given locations. */
async function addMember(
  orgId: string,
  user: SignedInUser,
  role: MembershipRole,
  locationIds: string[],
): Promise<void> {
  await ctx.prisma.membership.create({
    data: {
      userId: user.userId,
      organizationId: orgId,
      role,
      locations: { create: locationIds.map((locationId) => ({ locationId })) },
    },
  });
}

describe('organizations', () => {
  it('makes the creator the owner and records it in the audit log', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const res = await ctx
      .http()
      .post('/v1/organizations')
      .set(owner.auth)
      .send({ name: 'Barber Group', nip: '525-000-00-00' })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'Barber Group',
      nip: '5250000000',
      role: 'owner',
      country: 'PL',
    });

    const list = await ctx.http().get('/v1/organizations').set(owner.auth).expect(200);
    expect(list.body).toHaveLength(1);

    const me = await ctx.http().get('/v1/me').set(owner.auth).expect(200);
    expect(me.body.organizations).toEqual([
      { id: res.body.id, name: 'Barber Group', role: 'owner' },
    ]);

    const audit = await ctx.prisma.auditLog.findMany({ where: { organizationId: res.body.id } });
    expect(audit.map((a) => a.action)).toContain('organization.created');
  });

  it('rejects an invalid NIP', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const res = await ctx
      .http()
      .post('/v1/organizations')
      .set(owner.auth)
      .send({ name: 'Barber Group', nip: '123' })
      .expect(400);
    expectError(res.body, 'VALIDATION_ERROR');
  });
});

describe('locations', () => {
  it('creates a location with defaults and a slug generated from the name', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await ctx.http().post('/v1/organizations').set(owner.auth).send({ name: 'Group' });
    const res = await ctx
      .http()
      .post(`/v1/organizations/${org.body.id}/locations`)
      .set(owner.auth)
      .send(LOCATION)
      .expect(201);
    expect(res.body).toMatchObject({
      slug: 'barber-mokotow',
      timezone: 'Europe/Warsaw',
      defaultLocale: 'pl',
      slotStepMinutes: 15,
      minLeadMinutes: 60,
      bookingHorizonDays: 30,
      clientCancelDeadlineMinutes: 120,
      onlineBookingEnabled: false,
      version: 1,
    });

    const second = await ctx
      .http()
      .post(`/v1/organizations/${org.body.id}/locations`)
      .set(owner.auth)
      .send(LOCATION)
      .expect(201);
    expect(second.body.slug).toBe('barber-mokotow-2');
  });

  it('refuses a booking link that is already taken', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const { orgId, slug } = await createOrgWithLocation(ctx, owner, 'Group');
    const res = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({ ...LOCATION, slug })
      .expect(409);
    expectError(res.body, 'SLUG_TAKEN');
  });

  it('rejects an unknown time zone and a bad slot step', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await ctx.http().post('/v1/organizations').set(owner.auth).send({ name: 'Group' });
    const res = await ctx
      .http()
      .post(`/v1/organizations/${org.body.id}/locations`)
      .set(owner.auth)
      .send({ ...LOCATION, timezone: 'Europe/Atlantis', slotStepMinutes: 7 })
      .expect(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['timezone', 'slotStepMinutes']));
  });

  it('updates with the current version and refuses a stale one', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const { orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Group');
    const url = `/v1/organizations/${orgId}/locations/${locationId}`;

    const updated = await ctx
      .http()
      .patch(url)
      .set(owner.auth)
      .send({ version: 1, onlineBookingEnabled: true, phone: '+48123456789' })
      .expect(200);
    expect(updated.body).toMatchObject({
      version: 2,
      onlineBookingEnabled: true,
      phone: '+48123456789',
    });

    const stale = await ctx
      .http()
      .patch(url)
      .set(owner.auth)
      .send({ version: 1, name: 'Old tab' })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');
    const current = await ctx.http().get(url).set(owner.auth).expect(200);
    expect(current.body.name).not.toBe('Old tab');
  });
});

describe('roles inside one organization', () => {
  async function setup() {
    const owner = await signUp(ctx, 'owner@example.com');
    const { orgId, locationId: first } = await createOrgWithLocation(ctx, owner, 'Group');
    const other = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({ ...LOCATION, name: 'Barber Wola' })
      .expect(201);
    return { owner, orgId, first, second: other.body.id as string };
  }

  it('manager sees and edits only assigned locations, cannot create locations or edit the organization', async () => {
    const { orgId, first, second } = await setup();
    const manager = await signUp(ctx, 'manager@example.com');
    await addMember(orgId, manager, 'manager', [first]);

    const list = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/locations`)
      .set(manager.auth)
      .expect(200);
    expect(list.body.map((l: { id: string }) => l.id)).toEqual([first]);

    await ctx
      .http()
      .get(`/v1/organizations/${orgId}/locations/${second}`)
      .set(manager.auth)
      .expect(404);
    await ctx
      .http()
      .patch(`/v1/organizations/${orgId}/locations/${second}`)
      .set(manager.auth)
      .send({ version: 1, name: 'Hijacked' })
      .expect(404);
    await ctx
      .http()
      .patch(`/v1/organizations/${orgId}/locations/${first}`)
      .set(manager.auth)
      .send({ version: 1, name: 'Renamed by manager' })
      .expect(200);

    const create = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(manager.auth)
      .send(LOCATION)
      .expect(403);
    expectError(create.body, 'FORBIDDEN');
    await ctx
      .http()
      .patch(`/v1/organizations/${orgId}`)
      .set(manager.auth)
      .send({ name: 'Mine' })
      .expect(403);
  });

  it('staff can view their location but not change it', async () => {
    const { orgId, first } = await setup();
    const staff = await signUp(ctx, 'staff@example.com');
    await addMember(orgId, staff, 'staff', [first]);

    await ctx
      .http()
      .get(`/v1/organizations/${orgId}/locations/${first}`)
      .set(staff.auth)
      .expect(200);
    await ctx
      .http()
      .patch(`/v1/organizations/${orgId}/locations/${first}`)
      .set(staff.auth)
      .send({ version: 1, name: 'Renamed by staff' })
      .expect(403);
  });

  it('an invited (not yet active) member has no access', async () => {
    const { orgId } = await setup();
    const invited = await signUp(ctx, 'invited@example.com');
    await ctx.prisma.membership.create({
      data: { userId: invited.userId, organizationId: orgId, role: 'manager', status: 'invited' },
    });
    await ctx.http().get(`/v1/organizations/${orgId}`).set(invited.auth).expect(404);
  });
});
