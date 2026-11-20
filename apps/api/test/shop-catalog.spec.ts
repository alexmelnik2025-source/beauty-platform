import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
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

/**
 * Task Q3 (part 1): the platform catalogue ("Sklep") — one card per product, offered by salons
 * through their own products; what the salon's page and the "Sklep" tab show to clients.
 */

let ctx: TestContext;
let owner: SignedInUser;
let staffUser: SignedInUser;
let other: SignedInUser;
let base: string;
let otherBase: string;
let slug: string;
let otherSlug: string;

const POMADE = { name: 'Reuzel Pink Pomade', brand: 'Reuzel', ean: '0859104005020' };

/** A tiny file with PNG's first bytes: enough to pass the photo type check. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png'),
]);

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const salon = await createOrgWithLocation(ctx, owner, 'Barber');
  base = `/v1/organizations/${salon.orgId}/locations/${salon.locationId}`;
  slug = salon.slug;
  staffUser = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: staffUser.userId,
      organizationId: salon.orgId,
      role: 'staff',
      locations: { create: [{ locationId: salon.locationId }] },
    },
  });
  other = await signUp(ctx, 'other@example.com');
  const second = await createOrgWithLocation(ctx, other, 'Fryzjer');
  otherBase = `/v1/organizations/${second.orgId}/locations/${second.locationId}`;
  otherSlug = second.slug;
  // Both salons are open for online booking: only then do clients see their products.
  await ctx.prisma.location.updateMany({
    where: { id: { in: [salon.locationId, second.locationId] } },
    data: { onlineBookingEnabled: true, ...LEGAL_TEXTS },
  });
});

const shape = (name: string, body: unknown) =>
  expect(registeredResponseSchema(name).safeParse(body).error?.issues ?? []).toEqual([]);

const createCard = async (body: object, who = owner, where = base) =>
  (await ctx.http().post(`${where}/shop/catalog`).set(who.auth).send(body).expect(201)).body as {
    id: string;
  };

const createProduct = async (body: object, who = owner, where = base, status = 201) =>
  (await ctx.http().post(`${where}/products`).set(who.auth).send(body).expect(status)).body;

describe('The catalogue as the salon sees it (…/shop/catalog)', () => {
  it('makes a card, finds it by words or EAN, and refuses the same EAN twice', async () => {
    const res = await ctx
      .http()
      .post(`${base}/shop/catalog`)
      .set(owner.auth)
      .send({ ...POMADE, ean: '0859104 005020', category: 'styling', description: 'Mocny chwyt' })
      .expect(201);
    shape('CatalogProduct', res.body);
    expect(res.body).toMatchObject({
      name: POMADE.name,
      brand: 'Reuzel',
      ean: '0859104005020',
      category: 'styling',
      photoId: null,
      sellers: 0,
      editable: true,
      offeredHere: null,
    });

    // The same code again (from any salon): the existing card's id comes back, to offer that one.
    const dup = await ctx
      .http()
      .post(`${otherBase}/shop/catalog`)
      .set(other.auth)
      .send({ name: 'Pomada różowa', ean: POMADE.ean })
      .expect(409);
    expectError(dup.body, 'EAN_TAKEN');
    expect(dup.body.error.details[0].message).toBe(res.body.id);

    await createCard({ name: 'Wosk do brody', category: 'beard' });

    const byWord = await ctx
      .http()
      .get(`${base}/shop/catalog`)
      .query({ q: 'reuzel' })
      .set(staffUser.auth)
      .expect(200);
    shape('CatalogSearch', byWord.body);
    expect(byWord.body.products.map((p: { id: string }) => p.id)).toEqual([res.body.id]);

    const byCode = await ctx
      .http()
      .get(`${base}/shop/catalog`)
      .query({ q: '0859104-005020' })
      .set(owner.auth)
      .expect(200);
    expect(byCode.body.products.map((p: { id: string }) => p.id)).toEqual([res.body.id]);

    const all = await ctx.http().get(`${base}/shop/catalog`).set(owner.auth).expect(200);
    expect(all.body.products).toHaveLength(2);

    // Task 604: the card with exactly the scanned code is first even when more cards than the
    // limit carry the digits in their name ("Zestaw 59012345" …) and would fill the page first.
    const code = '5901234123457';
    for (let i = 0; i < 3; i += 1) {
      await createCard({ name: `Zestaw ${code} nr ${i}` });
    }
    const exact = await createCard({ name: 'Żel Reuzel', ean: code });
    const scanned = await ctx
      .http()
      .get(`${base}/shop/catalog`)
      .query({ q: code, limit: 2 })
      .set(owner.auth)
      .expect(200);
    expect(scanned.body.products).toHaveLength(2);
    expect(scanned.body.products[0].id).toBe(exact.id);

    // Specialists may look but not make cards.
    await ctx
      .http()
      .post(`${base}/shop/catalog`)
      .set(staffUser.auth)
      .send({ name: 'Szampon' })
      .expect(403);
  });

  it('lets the maker change a card only while no other salon offers it', async () => {
    const card = await createCard({ ...POMADE, category: 'styling' });
    const changed = await ctx
      .http()
      .patch(`${base}/shop/catalog/${card.id}`)
      .set(owner.auth)
      .send({ description: 'Średni chwyt, wysoki połysk' })
      .expect(200);
    expect(changed.body.description).toBe('Średni chwyt, wysoki połysk');

    // Another salon did not make it: not found there.
    await ctx
      .http()
      .patch(`${otherBase}/shop/catalog/${card.id}`)
      .set(other.auth)
      .send({ name: 'Inna nazwa' })
      .expect(404);

    // Once another salon offers the card, it belongs to everyone.
    await createProduct(
      { name: POMADE.name, priceGrosze: 7900, catalogProductId: card.id, inSalonShop: true },
      other,
      otherBase,
    );
    const shared = await ctx
      .http()
      .patch(`${base}/shop/catalog/${card.id}`)
      .set(owner.auth)
      .send({ name: 'Inna nazwa' })
      .expect(403);
    expectError(shared.body, 'CARD_SHARED');
    const seen = await ctx
      .http()
      .get(`${base}/shop/catalog/${card.id}`)
      .set(owner.auth)
      .expect(200);
    expect(seen.body).toMatchObject({ sellers: 1, editable: false, offeredHere: null });
  });
});

describe('A salon’s product as an offer (…/products with catalogProductId, inSalonShop, inMarketplace)', () => {
  it('needs a card and the salon’s own page for the "Sklep" tab, and checks the card exists', async () => {
    const noCard = await createProduct(
      { name: 'Pomada', priceGrosze: 5900, inSalonShop: true, inMarketplace: true },
      owner,
      base,
      409,
    );
    expectError(noCard, 'MARKETPLACE_NEEDS_CARD');

    const card = await createCard(POMADE);
    const hidden = await createProduct(
      { name: 'Pomada', priceGrosze: 5900, catalogProductId: card.id, inMarketplace: true },
      owner,
      base,
      409,
    );
    expectError(hidden, 'MARKETPLACE_NEEDS_SALON_SHOP');

    const ghost = await createProduct(
      {
        name: 'Pomada',
        priceGrosze: 5900,
        catalogProductId: '00000000-0000-7000-8000-000000000000',
        inSalonShop: true,
      },
      owner,
      base,
      404,
    );
    expectError(ghost, 'NOT_FOUND');

    const product = await createProduct({
      name: 'Pomada',
      priceGrosze: 5900,
      catalogProductId: card.id,
      inSalonShop: true,
    });
    shape('Product', product);
    expect(product).toMatchObject({
      catalogProductId: card.id,
      inSalonShop: true,
      inMarketplace: false,
    });

    // Switching the "Sklep" tab on, then taking the card away: the same rules on a change.
    const on = await ctx
      .http()
      .patch(`${base}/products/${product.id}`)
      .set(owner.auth)
      .send({ inMarketplace: true })
      .expect(200);
    expect(on.body.inMarketplace).toBe(true);
    const off = await ctx
      .http()
      .patch(`${base}/products/${product.id}`)
      .set(owner.auth)
      .send({ catalogProductId: null })
      .expect(409);
    expectError(off.body, 'MARKETPLACE_NEEDS_CARD');
    await ctx
      .http()
      .patch(`${base}/products/${product.id}`)
      .set(owner.auth)
      .send({ catalogProductId: null, inMarketplace: false })
      .expect(200);

    // The card now knows this salon offers it.
    await ctx
      .http()
      .patch(`${base}/products/${product.id}`)
      .set(owner.auth)
      .send({ catalogProductId: card.id })
      .expect(200);
    const seen = await ctx
      .http()
      .get(`${base}/shop/catalog/${card.id}`)
      .set(owner.auth)
      .expect(200);
    expect(seen.body).toMatchObject({ sellers: 1, editable: true, offeredHere: product.id });
  });
});

describe('What clients see', () => {
  it('"Produkty salonu": only the products the salon shows, available ones first', async () => {
    const card = await createCard({ ...POMADE, category: 'styling', description: 'Mocny chwyt' });
    await createProduct({
      name: 'Pomada Reuzel',
      priceGrosze: 5900,
      catalogProductId: card.id,
      inSalonShop: true,
      stockQuantity: 0,
    });
    await createProduct({ name: 'Wosk', priceGrosze: 3000, inSalonShop: true });
    await createProduct({ name: 'Szampon (tylko magazyn)', priceGrosze: 2000 });
    const gone = await createProduct({ name: 'Żel', priceGrosze: 1500, inSalonShop: true });
    await ctx
      .http()
      .patch(`${base}/products/${gone.id}`)
      .set(owner.auth)
      .send({ active: false })
      .expect(200);

    const res = await ctx.http().get(`/v1/public/locations/${slug}/products`).expect(200);
    shape('PublicSalonProducts', res.body);
    expect(res.body).toMatchObject({ currency: 'PLN', fulfillment: ['pickup_at_salon'] });
    expect(res.body.products).toEqual([
      expect.objectContaining({
        name: 'Wosk',
        brand: null,
        available: true,
        catalogProductId: null,
        category: null,
        description: null,
        photoId: null,
      }),
      expect.objectContaining({
        name: 'Pomada Reuzel',
        brand: 'Reuzel',
        priceGrosze: 5900,
        available: false,
        catalogProductId: card.id,
        category: 'styling',
        description: 'Mocny chwyt',
      }),
    ]);
    // Nothing of the stock itself leaves the salon.
    expect(JSON.stringify(res.body)).not.toMatch(/stockQuantity|purchasePrice|supplier/);

    // A salon closed for online booking shows nothing; an unknown one neither.
    await ctx.prisma.location.updateMany({
      where: { slug },
      data: { onlineBookingEnabled: false },
    });
    await ctx.http().get(`/v1/public/locations/${slug}/products`).expect(404);
    await ctx.http().get(`/v1/public/locations/nie-ma-takiego/products`).expect(404);
  });

  it('the "Sklep" tab: one card with every salon’s offer, cheapest available first', async () => {
    const card = await createCard({ ...POMADE, category: 'styling' });
    const beard = await createCard({ name: 'Olejek do brody', category: 'beard' });
    // This salon: the pomade in the tab, the oil only on its own page.
    await createProduct({
      name: 'Pomada Reuzel',
      priceGrosze: 5900,
      catalogProductId: card.id,
      inSalonShop: true,
      inMarketplace: true,
    });
    await createProduct({
      name: 'Olejek',
      priceGrosze: 4500,
      catalogProductId: beard.id,
      inSalonShop: true,
    });
    // The other salon: the same pomade cheaper, but none left.
    const cheaper = await createProduct(
      {
        name: 'Reuzel Pink',
        priceGrosze: 4900,
        catalogProductId: card.id,
        inSalonShop: true,
        inMarketplace: true,
        stockQuantity: 0,
      },
      other,
      otherBase,
    );

    const list = await ctx.http().get('/v1/public/shop/products').expect(200);
    shape('PublicShopList', list.body);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 24 });
    expect(list.body.products).toHaveLength(1);
    const [pomade] = list.body.products;
    expect(pomade).toMatchObject({
      id: card.id,
      name: POMADE.name,
      brand: 'Reuzel',
      ean: POMADE.ean,
      category: 'styling',
      fromPriceGrosze: 5900,
    });
    expect(pomade.offers).toEqual([
      expect.objectContaining({
        priceGrosze: 5900,
        available: true,
        currency: 'PLN',
        fulfillment: ['pickup_at_salon'],
        salon: expect.objectContaining({ slug, city: 'Warszawa' }),
      }),
      expect.objectContaining({
        productId: cheaper.id,
        priceGrosze: 4900,
        available: false,
        salon: expect.objectContaining({ slug: otherSlug }),
      }),
    ]);

    // Once the other salon has pieces again, its cheaper offer leads.
    await ctx
      .http()
      .post(`${otherBase}/products/${cheaper.id}/restock`)
      .set(other.auth)
      .send({ quantity: 3 })
      .expect(200);
    const one = await ctx.http().get(`/v1/public/shop/products/${card.id}`).expect(200);
    shape('PublicShopProduct', one.body);
    expect(one.body.fromPriceGrosze).toBe(4900);
    expect(one.body.offers[0]).toMatchObject({ productId: cheaper.id, available: true });

    // Filters: words, category, city.
    const byWord = await ctx
      .http()
      .get('/v1/public/shop/products')
      .query({ q: 'pink' })
      .expect(200);
    expect(byWord.body.total).toBe(1);
    const byCategory = await ctx
      .http()
      .get('/v1/public/shop/products')
      .query({ category: 'beard' })
      .expect(200);
    expect(byCategory.body.total).toBe(0);
    const byCity = await ctx
      .http()
      .get('/v1/public/shop/products')
      .query({ city: 'warszawa' })
      .expect(200);
    expect(byCity.body.total).toBe(1);
    const elsewhere = await ctx
      .http()
      .get('/v1/public/shop/products')
      .query({ city: 'Kraków' })
      .expect(200);
    expect(elsewhere.body.total).toBe(0);

    // A card nobody sells online is not in the tab.
    await ctx.http().get(`/v1/public/shop/products/${beard.id}`).expect(404);

    // A salon closed for online booking takes its offer with it.
    await ctx.prisma.location.updateMany({
      where: { slug },
      data: { onlineBookingEnabled: false },
    });
    const left = await ctx.http().get(`/v1/public/shop/products/${card.id}`).expect(200);
    expect(left.body.offers.map((o: { productId: string }) => o.productId)).toEqual([cheaper.id]);
  });
});

describe('The card’s picture (…/shop/catalog/:cardId/photo, part 2b)', () => {
  it('is set by the maker or the first seller, is public, and is not a salon photo', async () => {
    const card = await createCard(POMADE);
    const put = (where: string, who: SignedInUser) =>
      ctx
        .http()
        .put(`${where}/shop/catalog/${card.id}/photo`)
        .set(who.auth)
        .set('Content-Type', 'image/png')
        .send(PNG);

    // A salon that neither made nor offers the card: not found.
    await put(otherBase, other).expect(404);

    const set = await put(base, owner).expect(200);
    shape('Photo', set.body);
    expect(set.body).toMatchObject({ contentType: 'image/png', sizeBytes: PNG.length });
    const photoId = set.body.id as string;
    await ctx.http().get(`/v1/public/photos/${photoId}`).expect(200);
    const seen = await ctx
      .http()
      .get(`${base}/shop/catalog/${card.id}`)
      .set(owner.auth)
      .expect(200);
    expect(seen.body.photoId).toBe(photoId);

    // Not in the salon's gallery, nor on its booking page.
    const gallery = await ctx.http().get(`${base}/photos`).set(owner.auth).expect(200);
    expect(gallery.body).toEqual([]);
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.photos).toEqual([]);

    // The other salon offers the card: it may not replace a picture that is there…
    await createProduct(
      { name: POMADE.name, priceGrosze: 7900, catalogProductId: card.id, inSalonShop: true },
      other,
      otherBase,
    );
    const shared = await put(otherBase, other).expect(403);
    expectError(shared.body, 'CARD_SHARED');
    // …and neither may the maker now, nor remove it; the picture shows on both salons' pages.
    const makerToo = await put(base, owner).expect(403);
    expectError(makerToo.body, 'CARD_SHARED');
    await ctx
      .http()
      .delete(`${otherBase}/shop/catalog/${card.id}/photo`)
      .set(other.auth)
      .expect(404);
    const otherPage = await ctx
      .http()
      .get(`/v1/public/locations/${otherSlug}/products`)
      .expect(200);
    expect(otherPage.body.products[0]).toMatchObject({ photoId, catalogProductId: card.id });

    // A card without a picture gets its first one from any salon offering it.
    const bare = await createCard({ name: 'Wosk', category: 'styling' });
    await createProduct(
      { name: 'Wosk', priceGrosze: 3000, catalogProductId: bare.id, inSalonShop: true },
      other,
      otherBase,
    );
    const first = await ctx
      .http()
      .put(`${otherBase}/shop/catalog/${bare.id}/photo`)
      .set(other.auth)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(200);
    expect(first.body.id).toBeTruthy();
    // The maker, alone on its own card, replaces and removes freely.
    const own = await createCard({ name: 'Szampon' });
    await ctx
      .http()
      .put(`${base}/shop/catalog/${own.id}/photo`)
      .set(owner.auth)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(200);
    await ctx.http().delete(`${base}/shop/catalog/${own.id}/photo`).set(owner.auth).expect(204);
    await ctx.http().delete(`${base}/shop/catalog/${own.id}/photo`).set(owner.auth).expect(404);
  });
});
