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
 * Task 224: the labels the salon gave its clients ("stały klient", "broda") — a list with how
 * many clients have each, and the client list filtered by one label. Same visibility as the
 * client list: managers count only clients of their salons, other organizations see nothing.
 */

const FIVE_MIN = 5 * 60_000;
const DAY = 24 * 60 * 60_000;

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let customersBase: string;

const fromNow = (ms: number): string =>
  new Date(Math.floor((Date.now() + ms) / FIVE_MIN) * FIVE_MIN).toISOString();

async function client(name: string, phone: string, tags: string[]): Promise<string> {
  return (
    await ctx.http().post(customersBase).set(owner.auth).send({ name, phone, tags }).expect(201)
  ).body.id;
}

const tagsOf = async (auth: Record<string, string>, path = customersBase) => {
  const res = await ctx.http().get(`${path}/tags`).set(auth).expect(200);
  expect(registeredResponseSchema('CustomerTags').safeParse(res.body).error?.issues ?? []).toEqual(
    [],
  );
  return res.body.tags as { tag: string; clients: number }[];
};

const namesWith = async (tag: string, auth = owner.auth) =>
  (await ctx.http().get(customersBase).query({ tag }).set(auth).expect(200)).body.map(
    (c: { name: string }) => c.name,
  );

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
  customersBase = `/v1/organizations/${orgId}/customers`;
});

describe('client labels (task 224)', () => {
  it('lists the labels by how many clients have them and filters the clients by one', async () => {
    await client('Jan Nowak', '+48600000001', ['stały klient', 'broda']);
    await client('Adam Kowalski', '+48600000002', ['stały klient']);
    await client('Ewa Zielińska', '+48600000003', ['koloryzacja', 'Broda']);
    await client('Bez Etykiet', '+48600000004', []);

    expect(await tagsOf(owner.auth)).toEqual([
      { tag: 'stały klient', clients: 2 },
      { tag: 'broda', clients: 1 },
      { tag: 'Broda', clients: 1 },
      { tag: 'koloryzacja', clients: 1 },
    ]);
    expect(await namesWith('stały klient')).toEqual(['Adam Kowalski', 'Jan Nowak']);
    // Exactly as written in the card.
    expect(await namesWith('broda')).toEqual(['Jan Nowak']);
    expect(await namesWith('nikt')).toEqual([]);
    // Together with the search.
    expect(
      (
        await ctx
          .http()
          .get(customersBase)
          .query({ tag: 'stały klient', search: 'jan' })
          .set(owner.auth)
          .expect(200)
      ).body.map((c: { name: string }) => c.name),
    ).toEqual(['Jan Nowak']);
    // A label longer than a card allows is refused.
    await ctx
      .http()
      .get(customersBase)
      .query({ tag: 'x'.repeat(31) })
      .set(owner.auth)
      .expect(400);
  });

  it('leaves out clients whose data were erased', async () => {
    const jan = await client('Jan Nowak', '+48600000001', ['broda']);
    await client('Adam Kowalski', '+48600000002', ['broda']);
    await ctx
      .http()
      .post(`${customersBase}/${jan}/anonymize`)
      .set(owner.auth)
      .send({ version: 1 })
      .expect(200);
    expect(await tagsOf(owner.auth)).toEqual([{ tag: 'broda', clients: 1 }]);
    expect(await namesWith('broda')).toEqual(['Adam Kowalski']);
  });

  it('counts for a manager only the clients of their salons; staff and other salons get nothing', async () => {
    const haircutId = (
      await ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
        .expect(201)
    ).body.id;
    const staffId = (
      await ctx
        .http()
        .post(`${base}/staff`)
        .set(owner.auth)
        .send({ displayName: 'Kasia', serviceIds: [haircutId] })
        .expect(201)
    ).body.id;
    const jan = await client('Jan Nowak', '+48600000001', ['broda']);
    await client('Adam Kowalski', '+48600000002', ['broda', 'nowy']);
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId,
        start: fromNow(2 * DAY),
        customerId: jan,
        allowOutsideHours: true,
      })
      .expect(201);

    const manager = await signUp(ctx, 'manager@example.com');
    const kasia = await signUp(ctx, 'kasia@example.com');
    for (const [user, role] of [
      [manager, 'manager'],
      [kasia, 'staff'],
    ] as const) {
      await ctx.prisma.membership.create({
        data: {
          userId: user.userId,
          organizationId: orgId,
          role,
          locations: { create: [{ locationId }] },
        },
      });
    }
    // Only Jan has a visit in the manager's salon.
    expect(await tagsOf(manager.auth)).toEqual([{ tag: 'broda', clients: 1 }]);
    expect(await namesWith('broda', manager.auth)).toEqual(['Jan Nowak']);
    // A specialist does not use the client list.
    await ctx.http().get(`${customersBase}/tags`).set(kasia.auth).expect(403);

    // Another organization sees neither the labels nor the clients.
    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    expect(await tagsOf(stranger.auth, `/v1/organizations/${other.orgId}/customers`)).toEqual([]);
    await ctx.http().get(`${customersBase}/tags`).set(stranger.auth).expect(404);
  });
});
