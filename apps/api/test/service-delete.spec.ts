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

// Owner's manual test 03.11.2026 (T3): a service could only be hidden. Now a service that was
// never used can be deleted; one with visits or in a loyalty reward can only be hidden.

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let base: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@delete.test');
  const created = await createOrgWithLocation(ctx, owner, 'Delete Barber');
  orgId = created.orgId;
  base = `/v1/organizations/${orgId}/locations/${created.locationId}`;
});

async function addService(name = 'Strzyżenie'): Promise<string> {
  const res = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name, durationMinutes: 30, priceGrosze: 7000 })
    .expect(201);
  return res.body.id as string;
}

async function addStaff(serviceIds: string[]): Promise<string> {
  const res = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds })
    .expect(201);
  return res.body.id as string;
}

describe('deleting a service', () => {
  it('a never-used service is deleted, also from the specialists who did it', async () => {
    const serviceId = await addService();
    const staffId = await addStaff([serviceId]);
    await ctx.http().delete(`${base}/services/${serviceId}`).set(owner.auth).expect(204);
    await ctx.http().get(`${base}/services/${serviceId}`).set(owner.auth).expect(404);
    const staff = await ctx.http().get(`${base}/staff/${staffId}`).set(owner.auth).expect(200);
    expect(staff.body.serviceIds).toEqual([]);
    const audit = await ctx.prisma.auditLog.findMany({
      where: { action: 'service.deleted', entityId: serviceId },
    });
    expect(audit).toHaveLength(1);
  });

  it('a service with a visit (even a cancelled one) can only be hidden', async () => {
    const serviceId = await addService();
    const staffId = await addStaff([serviceId]);
    const start = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    start.setUTCHours(10, 0, 0, 0);
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId,
        staffId,
        start: start.toISOString(),
        allowOutsideHours: true,
        customer: { name: 'Jan Kowalski', phone: '+48600100200' },
      })
      .expect(201);
    const res = await ctx
      .http()
      .delete(`${base}/services/${serviceId}`)
      .set(owner.auth)
      .expect(409);
    expectError(res.body, 'SERVICE_IN_USE');
    expect(res.body.error.details).toEqual([
      { path: 'appointments', message: '1' },
      { path: 'loyalty', message: '0' },
    ]);
    await ctx.http().get(`${base}/services/${serviceId}`).set(owner.auth).expect(200);
  });

  it('a service named in a loyalty reward can only be hidden', async () => {
    const serviceId = await addService();
    await ctx.prisma.loyaltyProgram.create({ data: { organizationId: orgId } });
    const program = await ctx.prisma.loyaltyProgram.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
    await ctx.prisma.loyaltyReward.create({
      data: {
        programId: program.id,
        name: 'Darmowe strzyżenie',
        kind: 'free_service',
        freeServiceId: serviceId,
        cost: 6,
      },
    });
    const res = await ctx
      .http()
      .delete(`${base}/services/${serviceId}`)
      .set(owner.auth)
      .expect(409);
    expectError(res.body, 'SERVICE_IN_USE');
    expect(res.body.error.details).toEqual([
      { path: 'appointments', message: '0' },
      { path: 'loyalty', message: '1' },
    ]);
  });

  it('only the owner or a manager; another salon gets 404', async () => {
    const serviceId = await addService();
    const stranger = await signUp(ctx, 'stranger@delete.test');
    await createOrgWithLocation(ctx, stranger, 'Other Barber');
    await ctx.http().delete(`${base}/services/${serviceId}`).set(stranger.auth).expect(404);
    await ctx.http().get(`${base}/services/${serviceId}`).set(owner.auth).expect(200);
  });
});
