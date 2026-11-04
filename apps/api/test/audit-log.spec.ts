import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 23: the owner's "Dziennik zmian" — who changed what, newest first. */

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;

interface Entry {
  action: string;
  entityName: string | null;
  actor: { name: string } | null;
  fields: string[] | null;
  date: string | null;
}

const log = (query: Record<string, string | number> = {}, auth = owner.auth) =>
  ctx.http().get(`/v1/organizations/${orgId}/audit-log`).query(query).set(auth);

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com', 'Aleksander Owner');
  ({ orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
});

describe('Dziennik zmian', () => {
  it('shows who changed what, newest first, with current names and field names only', async () => {
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201);
    await ctx
      .http()
      .patch(`${base}/services/${service.body.id}`)
      .set(owner.auth)
      .send({ version: service.body.version, name: 'Strzyżenie męskie', priceGrosze: 9900 })
      .expect(200);
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
      .expect(201);
    await ctx
      .http()
      .post(`${base}/staff/${staff.body.id}/time-off`)
      .set(owner.auth)
      .send({ start: '2027-01-11T09:00', end: '2027-01-11T17:00' })
      .expect(201);

    const res = await log().expect(200);
    const parsed = registeredResponseSchema('AuditLog').safeParse(res.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    const items = res.body.items as Entry[];
    const actions = items.map((i) => i.action);
    expect(actions.slice(0, 4)).toEqual([
      'staff.time_off_added',
      'staff.created',
      'service.updated',
      'service.created',
    ]);
    expect(actions).toContain('location.created');
    expect(items[0]).toMatchObject({ entityName: 'Kasia', actor: { name: 'Aleksander Owner' } });
    // The current name, and which fields changed — not the old or new values.
    const updated = items.find((i) => i.action === 'service.updated')!;
    expect(updated.entityName).toBe('Strzyżenie męskie');
    expect(updated.fields).toEqual(expect.arrayContaining(['name', 'priceGrosze']));
    expect(JSON.stringify(res.body)).not.toContain('9900');
    expect(res.body.next).toBeNull();
  });

  it('pages back in time with `before`', async () => {
    for (const name of ['A', 'B', 'C']) {
      await ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .send({ name, durationMinutes: 30, priceGrosze: 1000 })
        .expect(201);
    }
    const first = await log({ limit: 2 }).expect(200);
    expect(first.body.items.map((i: Entry) => i.entityName)).toEqual(['C', 'B']);
    expect(first.body.next).toEqual(first.body.items[1].id);
    const second = await log({ limit: 2, before: first.body.next }).expect(200);
    expect(second.body.items[0].entityName).toBe('A');
  });

  it('owner only, and only the own organization', async () => {
    const manager = await signUp(ctx, 'manager@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: manager.userId,
        organizationId: orgId,
        role: 'manager',
        locations: { create: [{ locationId }] },
      },
    });
    expect((await log({}, manager.auth)).status).toBe(403);

    const other = await signUp(ctx, 'other@example.com');
    const otherOrg = await createOrgWithLocation(ctx, other, 'Inny');
    await ctx
      .http()
      .post(`/v1/organizations/${otherOrg.orgId}/locations/${otherOrg.locationId}/services`)
      .set(other.auth)
      .send({ name: 'Cudza usługa', durationMinutes: 30, priceGrosze: 1000 })
      .expect(201);
    expect((await log({}, other.auth)).status).toBe(404);
    const mine = await log().expect(200);
    expect(JSON.stringify(mine.body)).not.toContain('Cudza');
  });
});
