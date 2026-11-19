import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 475: "Przyjmij dostawę" — the pieces of the whole order added at once. */

let ctx: TestContext;
let owner: SignedInUser;
let staffUser: SignedInUser;
let base: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const { orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber');
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  staffUser = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: staffUser.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
});

type Stock = { products: { id: string; stockQuantity: number | null }[] };
const stock = (list: Stock['products']) =>
  Object.fromEntries(list.map((p) => [p.id, p.stockQuantity]));

describe('POST …/products/delivery (task 475)', () => {
  it('adds the pieces of many products at once, each a delivery in the history', async () => {
    const add = async (body: object) =>
      (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
        id: string;
      };
    const pomade = await add({
      name: 'Pomada',
      priceGrosze: 4500,
      stockQuantity: 2,
      lowStockAt: 3,
    });
    const wax = await add({ name: 'Wosk', priceGrosze: 3000 });
    const gel = await add({ name: 'Żel', priceGrosze: 2000, stockQuantity: 7 });
    const deliver = (items: unknown[], auth = owner.auth) =>
      ctx.http().post(`${base}/products/delivery`).set(auth).send({ items });

    const res = await deliver([
      { productId: pomade.id, quantity: 3 },
      { productId: wax.id, quantity: 4 },
    ]).expect(200);
    expect(registeredResponseSchema('StockDelivery').safeParse(res.body).error).toBeUndefined();
    expect(res.body).toMatchObject({ products: 2, pieces: 7 });
    // A product that did not count its pieces starts counting; the one not delivered stays.
    expect(stock(res.body.list)).toMatchObject({ [pomade.id]: 5, [wax.id]: 4, [gel.id]: 7 });
    const pomadeAfter = (res.body.list as { id: string; lowStock: boolean }[]).find(
      (p) => p.id === pomade.id,
    );
    expect(pomadeAfter?.lowStock).toBe(false);

    // "Historia magazynu": a delivery like the one of task 438.
    const history = await ctx
      .http()
      .get(`${base}/products/${pomade.id}/stock-history`)
      .set(owner.auth)
      .expect(200);
    expect(
      (
        history.body as { movements: { kind: string; change: number; quantityAfter: number }[] }
      ).movements.map(({ kind, change, quantityAfter }) => ({ kind, change, quantityAfter })),
    ).toEqual([
      { kind: 'delivery', change: 3, quantityAfter: 5 },
      { kind: 'correction', change: 2, quantityAfter: 2 },
    ]);

    // Nothing, zero, a negative number or the same product twice are refused.
    await deliver([]).expect(400);
    await deliver([{ productId: pomade.id, quantity: 0 }]).expect(400);
    await deliver([{ productId: pomade.id, quantity: -1 }]).expect(400);
    await deliver([{ productId: pomade.id, quantity: 100_001 }]).expect(400);
    await deliver([
      { productId: pomade.id, quantity: 1 },
      { productId: pomade.id, quantity: 2 },
    ]).expect(400);
    // Too many in stock for one of them: nothing is added, not even to the others.
    expectError(
      (
        await deliver([
          { productId: gel.id, quantity: 1 },
          { productId: pomade.id, quantity: 99_996 },
        ]).expect(409)
      ).body,
      'STOCK_LIMIT',
    );

    // Only owners and managers; another salon's or a missing product: 404 and nothing changes.
    await deliver([{ productId: pomade.id, quantity: 1 }], staffUser.auth).expect(403);
    await deliver([
      { productId: gel.id, quantity: 1 },
      { productId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
    ]).expect(404);
    const other = await signUp(ctx, 'other-delivery@example.com');
    await createOrgWithLocation(ctx, other, 'Other');
    await deliver([{ productId: pomade.id, quantity: 1 }], other.auth).expect(404);

    const list = (await ctx.http().get(`${base}/products`).set(owner.auth).expect(200))
      .body as Stock;
    expect(stock(list.products)).toMatchObject({ [pomade.id]: 5, [wax.id]: 4, [gel.id]: 7 });
  });
});
