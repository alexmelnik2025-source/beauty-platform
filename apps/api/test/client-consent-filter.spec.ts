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

/**
 * Task 245: "Zgoda na wiadomości" — the owner lists only the clients whose latest answer about
 * the salon messages is "yes", to know whom the salon may write to. Owners and managers only.
 */

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let customersBase: string;

async function client(name: string, phone: string): Promise<string> {
  return (await ctx.http().post(customersBase).set(owner.auth).send({ name, phone }).expect(201))
    .body.id;
}

async function answer(customerId: string, granted: boolean, minutesAgo: number): Promise<void> {
  await ctx.prisma.consentRecord.create({
    data: {
      customerId,
      type: 'marketing',
      version: 'test',
      granted,
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
}

const consented = async (auth = owner.auth, query: object = {}) => {
  const res = await ctx
    .http()
    .get(customersBase)
    .query({ marketing: 'yes', ...query })
    .set(auth)
    .expect(200);
  expect(registeredResponseSchema('CustomerList').safeParse(res.body).error?.issues ?? []).toEqual(
    [],
  );
  return res.body.map((c: { name: string }) => c.name);
};

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
  customersBase = `/v1/organizations/${orgId}/customers`;
});

describe('clients with consent to the salon messages (task 245)', () => {
  it('lists only clients whose latest answer is "yes"', async () => {
    const jan = await client('Jan', '+48600000001');
    const ewa = await client('Ewa', '+48600000002');
    const adam = await client('Adam', '+48600000003');
    await client('Bez odpowiedzi', '+48600000004');
    const ola = await client('Ola', '+48600000005');
    // Jan said yes twice (two bookings).
    await answer(jan, true, 60);
    await answer(jan, true, 10);
    await answer(ewa, true, 30);
    // Adam said yes, then unsubscribed.
    await answer(adam, true, 60);
    await answer(adam, false, 5);
    // Ola unsubscribed, then said yes again at a later booking.
    await answer(ola, false, 60);
    await answer(ola, true, 5);

    expect(await consented()).toEqual(['Ewa', 'Jan', 'Ola']);
    // Together with the search.
    expect(await consented(owner.auth, { search: 'Ew' })).toEqual(['Ewa']);
    // Without the filter, everyone.
    const all = await ctx.http().get(customersBase).set(owner.auth).expect(200);
    expect(all.body).toHaveLength(5);
    // Only "yes" is accepted.
    await ctx.http().get(customersBase).query({ marketing: 'no' }).set(owner.auth).expect(400);
  });

  it('a specialist gets no list; other salons do not leak', async () => {
    const jan = await client('Jan', '+48600000001');
    await answer(jan, true, 5);

    // Another organization's client with consent is not in this list, and vice versa.
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    const otherBase = `/v1/organizations/${other.orgId}/customers`;
    const piotr = (
      await ctx
        .http()
        .post(otherBase)
        .set(stranger.auth)
        .send({ name: 'Piotr', phone: '+48600000009' })
        .expect(201)
    ).body.id as string;
    await answer(piotr, true, 5);
    expect(await consented()).toEqual(['Jan']);
    const theirs = await ctx
      .http()
      .get(otherBase)
      .query({ marketing: 'yes' })
      .set(stranger.auth)
      .expect(200);
    expect(theirs.body.map((c: { name: string }) => c.name)).toEqual(['Piotr']);

    // A specialist does not get the client list at all.
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.http().get(customersBase).query({ marketing: 'yes' }).set(kasia.auth).expect(403);
  });
});
