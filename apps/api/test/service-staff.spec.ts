import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

// Owner's manual test 03.11.2026 (T5): a new service was not shown to clients until it was
// ticked at a specialist, with no hint. Now the service itself says who performs it
// (`staffIds`), takes them on creation and has its own "who performs it?" list.

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
  owner = await signUp(ctx, 'owner@service-staff.test');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Kto Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
});

async function addStaff(displayName: string, at = base, user = owner): Promise<string> {
  const res = await ctx.http().post(`${at}/staff`).set(user.auth).send({ displayName }).expect(201);
  return res.body.id as string;
}

async function enableBooking(): Promise<void> {
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true })
    .expect(200);
}

const SERVICE = { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 7000 };

describe('who performs a service', () => {
  it('a service created without specialists says so and is not on the booking page', async () => {
    await addStaff('Kasia');
    const created = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send(SERVICE)
      .expect(201);
    expect(created.body.staffIds).toEqual([]);
    await enableBooking();
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.services).toEqual([]);
  });

  it('specialists given on creation perform it at once — clients can book it', async () => {
    const kasia = await addStaff('Kasia');
    const ola = await addStaff('Ola');
    const created = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ ...SERVICE, staffIds: [ola, kasia, ola] })
      .expect(201);
    expect(created.body.staffIds).toEqual([kasia, ola].sort());

    const staff = await ctx.http().get(`${base}/staff/${kasia}`).set(owner.auth).expect(200);
    expect(staff.body.serviceIds).toEqual([created.body.id]);
    const list = await ctx.http().get(`${base}/services`).set(owner.auth).expect(200);
    expect(list.body[0].staffIds).toEqual([kasia, ola].sort());

    await enableBooking();
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.services.map((s: { id: string }) => s.id)).toEqual([created.body.id]);
  });

  it('the list can be changed later and cleared; other services of a specialist stay', async () => {
    const kasia = await addStaff('Kasia');
    const ola = await addStaff('Ola');
    const beard = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ ...SERVICE, name: 'Broda', staffIds: [kasia] })
      .expect(201);
    const cut = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ ...SERVICE, staffIds: [kasia] })
      .expect(201);

    const set = await ctx
      .http()
      .put(`${base}/services/${cut.body.id}/staff`)
      .set(owner.auth)
      .send({ staffIds: [ola] })
      .expect(200);
    expect(set.body.staffIds).toEqual([ola]);
    const kasiaNow = await ctx.http().get(`${base}/staff/${kasia}`).set(owner.auth).expect(200);
    expect(kasiaNow.body.serviceIds).toEqual([beard.body.id]);

    const cleared = await ctx
      .http()
      .put(`${base}/services/${cut.body.id}/staff`)
      .set(owner.auth)
      .send({ staffIds: [] })
      .expect(200);
    expect(cleared.body.staffIds).toEqual([]);
    const one = await ctx.http().get(`${base}/services/${cut.body.id}`).set(owner.auth).expect(200);
    expect(one.body.staffIds).toEqual([]);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { action: 'service.staff_set', entityId: cut.body.id },
    });
    expect(audit).toHaveLength(2);
  });

  it('specialists of another salon are never linked', async () => {
    const stranger = await signUp(ctx, 'other@service-staff.test');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny Barber');
    const foreign = await addStaff(
      'Obcy',
      `/v1/organizations/${other.orgId}/locations/${other.locationId}`,
      stranger,
    );
    const created = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ ...SERVICE, staffIds: [foreign] })
      .expect(400);
    expectError(created.body, 'VALIDATION_ERROR');
    expect(await ctx.prisma.service.count({ where: { locationId } })).toBe(0);

    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send(SERVICE)
      .expect(201);
    const res = await ctx
      .http()
      .put(`${base}/services/${service.body.id}/staff`)
      .set(owner.auth)
      .send({ staffIds: [foreign] })
      .expect(400);
    expectError(res.body, 'VALIDATION_ERROR');
    expect(await ctx.prisma.staffService.count({ where: { staffId: foreign } })).toBe(0);
  });

  it('a specialist (staff role) cannot change who performs a service', async () => {
    const kasia = await addStaff('Kasia');
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send(SERVICE)
      .expect(201);
    const worker = await signUp(ctx, 'kasia@service-staff.test');
    await ctx.prisma.membership.create({
      data: {
        userId: worker.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx
      .http()
      .put(`${base}/services/${service.body.id}/staff`)
      .set(worker.auth)
      .send({ staffIds: [kasia] })
      .expect(403);
    expect(await ctx.prisma.staffService.count({ where: { staffId: kasia } })).toBe(0);
  });
});
