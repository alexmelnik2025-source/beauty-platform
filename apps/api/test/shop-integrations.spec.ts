import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Task Q4 (part 1): "Mój sklep" → "Integracje" → "Base (BaseLinker)": the seller's token is
 * checked and kept encrypted, the catalogue / price group / warehouse are chosen, and the ticked
 * products are imported and joined to the platform catalogue by EAN. Base itself is a stand-in
 * (fetch is replaced in the test): no real token or account is ever used.
 */

let ctx: TestContext;
let owner: SignedInUser;
let staffUser: SignedInUser;
let base: string;
let locationId: string;

const TOKEN = '3001234-3005678-DEVONLYFAKETOKEN0000000000';
const OTHER_TOKEN = '3009999-3009999-DEVONLYFAKETOKEN9999999999';

const POMADE_EAN = '0859104005020';

/** What the stand-in Base holds: two catalogues, PLN and EUR price groups, one warehouse. */
const fakeBase = {
  getInventories: {
    inventories: [
      {
        inventory_id: 307,
        name: 'Sklep GESTALT',
        price_groups: [105, 106],
        default_price_group: 105,
        warehouses: ['bl_201'],
        default_warehouse: 'bl_201',
      },
      { inventory_id: 308, name: 'Allegro', price_groups: [105], warehouses: ['bl_201'] },
    ],
  },
  getInventoryPriceGroups: {
    price_groups: [
      { price_group_id: 105, name: 'Detal', currency: 'PLN' },
      { price_group_id: 106, name: 'Euro', currency: 'EUR' },
    ],
  },
  getInventoryWarehouses: {
    warehouses: [{ warehouse_type: 'bl', warehouse_id: 201, name: 'Magazyn Wola' }],
  },
  getInventoryProductsList: {
    products: {
      '9001': {
        id: 9001,
        ean: POMADE_EAN,
        sku: 'RZ-PINK',
        name: 'Reuzel Pink Pomade 113 g',
        prices: { '105': 69.99 },
        stock: { bl_201: 12 },
      },
      '9002': {
        id: 9002,
        ean: '5901234123457',
        sku: 'OIL-1',
        name: 'Olejek do brody',
        prices: { '105': '45,50' },
        stock: { bl_201: 3 },
      },
      '9003': { id: 9003, ean: '', sku: 'NOPRICE', name: 'Grzebień', prices: {}, stock: {} },
    },
  },
  getInventoryProductsData: {
    products: {
      '9001': {
        ean: POMADE_EAN,
        sku: 'RZ-PINK',
        manufacturer_id: 12,
        text_fields: {
          name: 'Reuzel Pink Pomade 113 g',
          description: '<p>Mocne utrwalenie,<br>wysoki połysk &amp; zapach wanilii.</p>',
        },
        prices: { '105': 69.99 },
        stock: { bl_201: 12 },
        images: { '0': 'https://example.com/pomade.jpg' },
      },
      '9002': {
        ean: '5901234123457',
        sku: 'OIL-1',
        manufacturer_id: 0,
        text_fields: { name: 'Olejek do brody' },
        prices: { '105': '45,50' },
        stock: { bl_201: 3 },
      },
      '9003': {
        ean: '',
        sku: 'NOPRICE',
        text_fields: { name: 'Grzebień' },
        prices: {},
        stock: {},
      },
    },
  },
  getInventoryManufacturers: { manufacturers: [{ manufacturer_id: 12, name: 'Reuzel' }] },
} as Record<string, Record<string, unknown>>;

/** Calls Base received in this test: [method, token, parameters]. */
let calls: [string, string, Record<string, unknown>][];

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://api.baselinker.com/')) {
      throw new Error(`Unexpected fetch ${String(input)}`);
    }
    const form = new URLSearchParams(String(init?.body));
    const method = form.get('method') ?? '';
    const token = new Headers(init?.headers).get('X-BLToken') ?? '';
    calls.push([method, token, JSON.parse(form.get('parameters') ?? '{}')]);
    const json = (body: object) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (token !== TOKEN && token !== OTHER_TOKEN) {
      return json({ status: 'ERROR', error_code: 'ERROR_BAD_TOKEN', error_message: 'Bad token' });
    }
    const answer = fakeBase[method];
    return answer
      ? json({ status: 'SUCCESS', ...answer })
      : json({ status: 'ERROR', error_code: 'ERROR_UNKNOWN_METHOD', error_message: method });
  });

  owner = await signUp(ctx, 'owner@example.com');
  const salon = await createOrgWithLocation(ctx, owner, 'Barber');
  locationId = salon.locationId;
  base = `/v1/organizations/${salon.orgId}/locations/${salon.locationId}/shop/integrations/base`;
  staffUser = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: staffUser.userId,
      organizationId: salon.orgId,
      role: 'staff',
      locations: { create: [{ locationId: salon.locationId }] },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The request fails with this status and error code. */
const fails = async (
  req: ReturnType<ReturnType<TestContext['http']>['get']>,
  status: number,
  code: string,
) => expectError((await req.expect(status)).body, code);

const shape = (name: string, body: unknown) =>
  expect(registeredResponseSchema(name).safeParse(body).error?.issues ?? []).toEqual([]);

const connect = async (token = TOKEN) =>
  (await ctx.http().put(base).set(owner.auth).send({ token }).expect(200)).body;

const configure = async () =>
  (
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ inventoryId: '307', priceGroupId: '105', warehouseId: 'bl_201' })
      .expect(200)
  ).body;

describe('Connecting Base (…/shop/integrations/base)', () => {
  it('checks the token with Base, keeps it encrypted and never sends it back', async () => {
    const empty = await ctx.http().get(base).set(owner.auth).expect(200);
    shape('BaseIntegration', empty.body);
    expect(empty.body).toMatchObject({ connected: false, tokenHint: null, importedProducts: 0 });

    await fails(
      ctx.http().put(base).set(owner.auth).send({ token: 'wrong-token-0000000000000' }),
      422,
      'BASE_TOKEN_INVALID',
    );
    expect(await ctx.prisma.shopIntegration.count()).toBe(0);

    const res = await ctx.http().put(base).set(owner.auth).send({ token: TOKEN }).expect(200);
    shape('BaseIntegration', res.body);
    expect(res.body).toMatchObject({
      connected: true,
      tokenHint: '0000',
      tokenReadable: true,
      inventoryId: null,
    });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(calls.at(-1)).toEqual(['getInventories', TOKEN, {}]);

    const row = await ctx.prisma.shopIntegration.findFirstOrThrow();
    expect(row.tokenCiphertext).not.toContain(TOKEN);
    expect(row.tokenCiphertext.startsWith('v1.')).toBe(true);
    expect(row.createdByUserId).toBe(owner.userId);

    // A token sealed with another key (the server secret changed) asks to paste it again.
    await ctx.prisma.shopIntegration.update({
      where: { id: row.id },
      data: { tokenCiphertext: 'v1.AAAA.BBBB.CCCC' },
    });
    expect((await ctx.http().get(base).set(owner.auth).expect(200)).body.tokenReadable).toBe(false);
    await fails(ctx.http().get(`${base}/options`).set(owner.auth), 409, 'BASE_RECONNECT');

    // Pasting a token again replaces it.
    expect((await connect(OTHER_TOKEN)).tokenHint).toBe('9999');
    expect(await ctx.prisma.shopIntegration.count()).toBe(1);
  });

  it('is for owners and managers only, and only of their own salon', async () => {
    await fails(ctx.http().get(base).set(staffUser.auth), 403, 'FORBIDDEN');
    await fails(ctx.http().put(base).set(staffUser.auth).send({ token: TOKEN }), 403, 'FORBIDDEN');
    const stranger = await signUp(ctx, 'stranger@example.com');
    await createOrgWithLocation(ctx, stranger, 'Inny');
    await fails(ctx.http().get(base).set(stranger.auth), 404, 'NOT_FOUND');
    await ctx.http().get(base).expect(401);
  });

  it('lists catalogues, price groups and warehouses, and takes only a sensible choice', async () => {
    await fails(ctx.http().get(`${base}/options`).set(owner.auth), 409, 'BASE_NOT_CONNECTED');
    await connect();
    const options = await ctx.http().get(`${base}/options`).set(owner.auth).expect(200);
    shape('BaseOptions', options.body);
    expect(options.body.inventories[0]).toEqual({
      id: '307',
      name: 'Sklep GESTALT',
      priceGroupIds: ['105', '106'],
      defaultPriceGroupId: '105',
      warehouseIds: ['bl_201'],
      defaultWarehouseId: 'bl_201',
    });
    expect(options.body.priceGroups).toEqual([
      { id: '105', name: 'Detal', currency: 'PLN', matchesSalon: true },
      { id: '106', name: 'Euro', currency: 'EUR', matchesSalon: false },
    ]);
    expect(options.body.warehouses).toEqual([{ id: 'bl_201', name: 'Magazyn Wola' }]);

    const choose = (body: object) => ctx.http().patch(base).set(owner.auth).send(body);
    const good = { inventoryId: '307', priceGroupId: '105', warehouseId: 'bl_201' };
    await fails(choose({ ...good, inventoryId: '999' }), 422, 'BASE_INVALID_CHOICE');
    // Euro prices for a PLN salon would be wrong prices.
    await fails(choose({ ...good, priceGroupId: '106' }), 422, 'BASE_INVALID_CHOICE');
    await fails(choose({ ...good, warehouseId: 'bl_999' }), 422, 'BASE_INVALID_CHOICE');
    // The second catalogue does not have the EUR group at all.
    await fails(
      choose({ ...good, inventoryId: '308', priceGroupId: '106' }),
      422,
      'BASE_INVALID_CHOICE',
    );

    const res = await choose(good).expect(200);
    expect(res.body).toMatchObject({
      inventoryId: '307',
      inventoryName: 'Sklep GESTALT',
      priceGroupId: '105',
      warehouseId: 'bl_201',
      lastImportAt: null,
    });
  });
});

describe('Importing products from Base', () => {
  it('shows a page of the catalogue with prices, stock and the matching card', async () => {
    await connect();
    await fails(ctx.http().get(`${base}/products`).set(owner.auth), 409, 'BASE_NOT_CONFIGURED');
    await configure();
    // The pomade is already in the platform catalogue (another salon made the card).
    const card = await ctx.prisma.catalogProduct.create({
      data: { name: 'Reuzel Pink Pomade', brand: 'Reuzel', ean: POMADE_EAN },
    });

    const res = await ctx.http().get(`${base}/products`).set(owner.auth).expect(200);
    shape('BaseProducts', res.body);
    expect(res.body.page).toBe(1);
    expect(res.body.hasMore).toBe(false);
    expect(calls.at(-1)).toEqual([
      'getInventoryProductsList',
      TOKEN,
      { inventory_id: 307, page: 1 },
    ]);
    expect(res.body.products).toEqual([
      {
        externalId: '9001',
        name: 'Reuzel Pink Pomade 113 g',
        ean: POMADE_EAN,
        sku: 'RZ-PINK',
        priceGrosze: 6999,
        stock: 12,
        importedProductId: null,
        catalogProductId: card.id,
      },
      {
        externalId: '9002',
        name: 'Olejek do brody',
        ean: '5901234123457',
        sku: 'OIL-1',
        priceGrosze: 4550,
        stock: 3,
        importedProductId: null,
        catalogProductId: null,
      },
      {
        externalId: '9003',
        name: 'Grzebień',
        ean: null,
        sku: 'NOPRICE',
        priceGrosze: null,
        stock: null,
        importedProductId: null,
        catalogProductId: null,
      },
    ]);
  });

  it('imports only the ticked products, joins cards by EAN and renews them next time', async () => {
    await connect();
    await configure();
    const card = await ctx.prisma.catalogProduct.create({
      data: { name: 'Reuzel Pink Pomade', brand: 'Reuzel', ean: POMADE_EAN },
    });
    // The salon already wrote the beard oil by hand with the same code: it is joined, not doubled.
    const own = await ctx.prisma.product.create({
      data: { locationId, name: 'Olejek', priceGrosze: 4000, barcode: '5901234123457' },
    });

    const res = await ctx
      .http()
      .post(`${base}/import`)
      .set(owner.auth)
      .send({
        items: [
          { externalId: '9001', online: true },
          { externalId: '9002' },
          { externalId: '9003' },
          { externalId: '777' },
        ],
      })
      .expect(200);
    shape('BaseImportResult', res.body);
    expect(res.body).toEqual({
      created: 1,
      updated: 1,
      cardsCreated: 1,
      cardsMatched: 1,
      skipped: [
        { externalId: '9003', reason: 'NO_PRICE' },
        { externalId: '777', reason: 'NOT_IN_BASE' },
      ],
    });
    expect(calls.find((c) => c[0] === 'getInventoryProductsData')?.[2]).toEqual({
      inventory_id: 307,
      products: [9001, 9002, 9003, 777],
    });

    const pomade = await ctx.prisma.product.findFirstOrThrow({
      where: { locationId, externalRef: 'base:307:9001' },
    });
    expect(pomade).toMatchObject({
      name: 'Reuzel Pink Pomade 113 g',
      priceGrosze: 6999,
      stockQuantity: 12,
      barcode: POMADE_EAN,
      catalogProductId: card.id,
      inSalonShop: true,
      inMarketplace: true,
      active: true,
    });
    const oil = await ctx.prisma.product.findUniqueOrThrow({
      where: { id: own.id },
      include: { catalogProduct: true },
    });
    expect(oil).toMatchObject({
      externalRef: 'base:307:9002',
      priceGrosze: 4550,
      stockQuantity: 3,
      inSalonShop: true,
      inMarketplace: false,
    });
    expect(oil.catalogProduct).toMatchObject({
      name: 'Olejek do brody',
      ean: '5901234123457',
      brand: null,
      createdByLocationId: locationId,
    });
    expect(await ctx.prisma.product.count({ where: { locationId } })).toBe(2);
    // The stock that came from Base is in the product's history.
    expect(
      await ctx.prisma.stockMovement.findMany({
        where: { productId: pomade.id },
        select: { kind: true, change: true, quantityAfter: true, note: true },
      }),
    ).toEqual([{ kind: 'correction', change: 12, quantityAfter: 12, note: 'Base' }]);

    const status = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(status.body.importedProducts).toBe(2);
    expect(status.body.lastImportAt).not.toBeNull();

    // The salon's page shows them; only the pomade goes to "Sklep".
    const list = await ctx.http().get(`${base}/products`).set(owner.auth).expect(200);
    expect(list.body.products[0].importedProductId).toBe(pomade.id);
    expect(list.body.products[1].importedProductId).toBe(own.id);

    // Next import: the price in Base changed, the same product is renewed, nothing doubles.
    const pomadeInBase = (
      fakeBase.getInventoryProductsData?.products as Record<
        string,
        { prices: object; stock: object }
      >
    )['9001'];
    if (!pomadeInBase) throw new Error('the stand-in has no pomade');
    const before = structuredClone(pomadeInBase);
    pomadeInBase.prices = { '105': 59.0 };
    pomadeInBase.stock = { bl_201: 10 };
    try {
      const again = await ctx
        .http()
        .post(`${base}/import`)
        .set(owner.auth)
        .send({ items: [{ externalId: '9001', online: false }] })
        .expect(200);
      expect(again.body).toMatchObject({
        created: 0,
        updated: 1,
        cardsCreated: 0,
        cardsMatched: 0,
      });
    } finally {
      Object.assign(pomadeInBase, before);
    }
    expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id: pomade.id } })).toMatchObject({
      priceGrosze: 5900,
      stockQuantity: 10,
      inMarketplace: false,
    });
    expect(await ctx.prisma.product.count({ where: { locationId } })).toBe(2);
  });

  it('makes a new card with the maker and a plain-text description when none matches', async () => {
    await connect();
    await configure();
    const res = await ctx
      .http()
      .post(`${base}/import`)
      .set(owner.auth)
      .send({ items: [{ externalId: '9001' }] })
      .expect(200);
    expect(res.body).toMatchObject({ created: 1, cardsCreated: 1, cardsMatched: 0 });
    const card = await ctx.prisma.catalogProduct.findUniqueOrThrow({ where: { ean: POMADE_EAN } });
    expect(card).toMatchObject({
      name: 'Reuzel Pink Pomade 113 g',
      brand: 'Reuzel',
      description: 'Mocne utrwalenie,\nwysoki połysk & zapach wanilii.',
      createdByLocationId: locationId,
    });
    // Nothing goes online unless ticked.
    expect(
      await ctx.prisma.product.findFirstOrThrow({ where: { externalRef: 'base:307:9001' } }),
    ).toMatchObject({ inSalonShop: true, inMarketplace: false });
  });

  it('refuses to import before the choices, and forgets the token on disconnect', async () => {
    const send = () =>
      ctx
        .http()
        .post(`${base}/import`)
        .set(owner.auth)
        .send({ items: [{ externalId: '9001' }] });
    await fails(send(), 409, 'BASE_NOT_CONNECTED');
    await connect();
    await fails(send(), 409, 'BASE_NOT_CONFIGURED');
    await fails(
      ctx
        .http()
        .post(`${base}/import`)
        .set(owner.auth)
        .send({ items: [{ externalId: '9001' }, { externalId: '9001' }] }),
      400,
      'VALIDATION_ERROR',
    );
    await configure();
    await send().expect(200);

    const res = await ctx.http().delete(base).set(owner.auth).expect(200);
    expect(res.body).toMatchObject({ connected: false, tokenHint: null, importedProducts: 1 });
    expect(await ctx.prisma.shopIntegration.count()).toBe(0);
    // The imported product stays the salon's own.
    expect(await ctx.prisma.product.count({ where: { externalRef: 'base:307:9001' } })).toBe(1);
  });

  it('tells the seller when Base answers with its own error', async () => {
    await connect();
    await configure();
    const original = fakeBase.getInventoryProductsList ?? {};
    delete fakeBase.getInventoryProductsList;
    try {
      await fails(ctx.http().get(`${base}/products`).set(owner.auth), 502, 'BASE_ERROR');
    } finally {
      fakeBase.getInventoryProductsList = original;
    }
  });
});
