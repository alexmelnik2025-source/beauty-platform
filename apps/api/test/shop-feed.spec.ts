import dns from 'node:dns';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { parseFeed, parsePrice } from '../src/shop/integrations/feed-parser';
import { decodeFeed } from '../src/shop/integrations/feed.service';
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
 * Task Q4 (part 3): "Importuj z pliku" — a seller without Base sends its product file (Google
 * Merchant XML, Ceneo XML or CSV), ticks products and imports them like from Base.
 */

const GOOGLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>
<title>Sklep</title>
<item>
  <g:id>RZ-1</g:id>
  <g:title><![CDATA[Reuzel Pink Pomade & więcej]]></g:title>
  <g:description>Mocne &lt;b&gt;utrwalenie&lt;/b&gt;</g:description>
  <g:price>69.99 PLN</g:price>
  <g:sale_price>59.00 PLN</g:sale_price>
  <g:gtin>0859104005020</g:gtin>
  <g:brand>Reuzel</g:brand>
  <g:availability>out_of_stock</g:availability>
  <g:image_link>https://example.com/p.jpg</g:image_link>
</item>
<item><g:id>NO-NAME</g:id><g:price>1 PLN</g:price></item>
</channel></rss>`;

const CENEO = `<?xml version="1.0" encoding="utf-8"?>
<offers xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="1">
<group name="other">
<o id="501" url="https://example.com/501" price="45.50" avail="1" stock="3">
  <cat><![CDATA[Broda]]></cat>
  <name><![CDATA[Olejek do brody]]></name>
  <imgs><main url="https://example.com/501.jpg"/></imgs>
  <desc><![CDATA[<p>Cedr</p>]]></desc>
  <attrs><a name="Producent"><![CDATA[Barber Co]]></a><a name="EAN"><![CDATA[5901234123457]]></a></attrs>
</o>
</group>
</offers>`;

const CSV = [
  'Symbol;Nazwa;EAN;Cena brutto;Stan;Marka;Opis',
  'GR-1;"Grzebień ""Pro""; czarny";;"12,00";10;;"Dwie',
  'linie"',
  'OIL-1;Olejek do brody;5901234123457;45,50 zł;2;Barber Co;',
  'EUR-1;Wosk;;9.99 EUR;1;;',
  'NOPRICE;Szczotka;;;;;',
  ';Bez symbolu;;5;;;',
].join('\r\n');

describe('Reading product files', () => {
  it('reads Google Merchant XML: sale price first, out of stock as 0, entities and CDATA', () => {
    const feed = parseFeed(GOOGLE);
    expect(feed.format).toBe('google');
    expect(feed.unreadable).toBe(1);
    expect(feed.rows).toEqual([
      {
        key: 'RZ-1',
        name: 'Reuzel Pink Pomade & więcej',
        ean: '0859104005020',
        sku: null,
        brand: 'Reuzel',
        price: 59,
        currency: 'PLN',
        stock: 0,
        description: 'Mocne <b>utrwalenie</b>',
        imageUrl: 'https://example.com/p.jpg',
      },
    ]);
  });

  it('reads Ceneo XML with its attributes', () => {
    const feed = parseFeed(CENEO);
    expect(feed.format).toBe('ceneo');
    expect(feed.rows).toEqual([
      {
        key: '501',
        name: 'Olejek do brody',
        ean: '5901234123457',
        sku: null,
        brand: 'Barber Co',
        price: 45.5,
        currency: null,
        stock: 3,
        description: '<p>Cedr</p>',
        imageUrl: 'https://example.com/501.jpg',
      },
    ]);
  });

  it('reads a Polish CSV: columns by name, quotes, commas in prices, Windows-1250', () => {
    const feed = parseFeed(CSV);
    expect(feed.format).toBe('csv');
    expect(feed.unreadable).toBe(1);
    expect(feed.rows.map((r) => [r.key, r.name, r.price, r.currency, r.stock])).toEqual([
      ['GR-1', 'Grzebień "Pro"; czarny', 12, null, 10],
      ['OIL-1', 'Olejek do brody', 45.5, 'PLN', 2],
      ['EUR-1', 'Wosk', 9.99, 'EUR', 1],
      ['NOPRICE', 'Szczotka', null, null, null],
    ]);
    expect(feed.rows[0]?.description).toBe('Dwie\nlinie');
    expect(feed.rows[1]).toMatchObject({ ean: '5901234123457', brand: 'Barber Co', sku: 'OIL-1' });

    // Polish Excel saves CSV in Windows-1250: "ń" is the byte 0xF1 there.
    const cp1250 = Buffer.from('Nazwa,Cena,SKU\nGrzebie\xf1,5,G1\n', 'latin1');
    expect(parseFeed(decodeFeed(cp1250)).rows[0]?.name).toBe('Grzebień');
    expect(parsePrice('1.299,00 zł')).toEqual({ price: 1299, currency: 'PLN' });
    expect(parsePrice('1,299.50')).toEqual({ price: 1299.5, currency: null });
    expect(parsePrice('abc')).toEqual({ price: null, currency: null });
  });
});

/** The smallest PNG: 1×1 pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

let ctx: TestContext;
let owner: SignedInUser;
let feedBase: string;
let locationId: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

const shape = (name: string, body: unknown) =>
  expect(registeredResponseSchema(name).safeParse(body).error?.issues ?? []).toEqual([]);

const send = (body: string, type = 'text/csv', who = owner) =>
  ctx.http().post(feedBase).set(who.auth).set('Content-Type', type).send(body);

describe('Importing from a file (…/shop/integrations/feed)', () => {
  beforeEach(async () => {
    await resetState(ctx);
    owner = await signUp(ctx, 'owner@example.com');
    const salon = await createOrgWithLocation(ctx, owner, 'Barber');
    locationId = salon.locationId;
    feedBase = `/v1/organizations/${salon.orgId}/locations/${salon.locationId}/shop/integrations/feed`;
    // Pictures in the files: a 1×1 PNG at example.com/p.jpg, nothing anywhere else.
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [
      { address: '93.184.215.14', family: 4 },
    ]) as unknown as typeof dns.promises.lookup);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input) === 'https://example.com/p.jpg'
        ? new Response(new Uint8Array(PNG))
        : new Response('nope', { status: 404 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows what was read, imports the ticked rows and renews them from a newer file', async () => {
    const card = await ctx.prisma.catalogProduct.create({
      data: { name: 'Olejek', ean: '5901234123457' },
    });
    const res = await send(CSV).expect(201);
    shape('ShopFeedPreview', res.body);
    expect(res.body.format).toBe('csv');
    expect(res.body.unreadable).toBe(1);
    expect(
      res.body.products.map((p: { key: string; priceGrosze: number | null }) => [
        p.key,
        p.priceGrosze,
      ]),
    ).toEqual([
      ['GR-1', 1200],
      ['OIL-1', 4550],
      // Euro prices in a PLN salon would be wrong prices.
      ['EUR-1', null],
      ['NOPRICE', null],
    ]);
    expect(res.body.products[1]).toMatchObject({ catalogProductId: card.id, stock: 2 });

    const imported = await ctx
      .http()
      .post(`${feedBase}/${res.body.feedId}/import`)
      .set(owner.auth)
      .send({
        items: [
          { key: 'GR-1' },
          { key: 'OIL-1', online: true },
          { key: 'EUR-1' },
          { key: 'NOPRICE' },
          { key: 'NOPE' },
        ],
      })
      .expect(200);
    shape('ShopFeedImportResult', imported.body);
    expect(imported.body).toEqual({
      created: 2,
      updated: 0,
      cardsCreated: 1,
      cardsMatched: 1,
      photosAdded: 0,
      skipped: [
        { key: 'EUR-1', reason: 'OTHER_CURRENCY' },
        { key: 'NOPRICE', reason: 'NO_PRICE' },
        { key: 'NOPE', reason: 'NOT_IN_FEED' },
      ],
    });
    const oil = await ctx.prisma.product.findFirstOrThrow({
      where: { locationId, externalRef: 'feed:OIL-1' },
    });
    expect(oil).toMatchObject({
      priceGrosze: 4550,
      stockQuantity: 2,
      catalogProductId: card.id,
      inSalonShop: true,
      inMarketplace: true,
    });
    expect(
      await ctx.prisma.stockMovement.findFirst({
        where: { productId: oil.id },
        select: { note: true },
      }),
    ).toEqual({ note: 'Plik' });

    // A newer file: the comb costs more now; the same product is renewed, nothing doubles.
    const newer = await send('SKU,Name,Price,Stock\nGR-1,Grzebień,15,4\n').expect(201);
    expect(newer.body.products[0].importedProductId).not.toBeNull();
    const again = await ctx
      .http()
      .post(`${feedBase}/${newer.body.feedId}/import`)
      .set(owner.auth)
      .send({ items: [{ key: 'GR-1' }] })
      .expect(200);
    expect(again.body).toMatchObject({ created: 0, updated: 1 });
    expect(
      await ctx.prisma.product.findFirstOrThrow({ where: { externalRef: 'feed:GR-1' } }),
    ).toMatchObject({ priceGrosze: 1500, stockQuantity: 4 });
    expect(await ctx.prisma.product.count({ where: { locationId } })).toBe(2);
  });

  it('takes XML feeds too, and refuses files it cannot read', async () => {
    const google = await send(GOOGLE, 'application/xml').expect(201);
    expect(google.body).toMatchObject({ format: 'google', unreadable: 1 });
    expect(google.body.products[0]).toMatchObject({ key: 'RZ-1', priceGrosze: 5900, stock: 0 });
    // g:image_link becomes the photo of the new card.
    const imported = await ctx
      .http()
      .post(`${feedBase}/${google.body.feedId}/import`)
      .set(owner.auth)
      .send({ items: [{ key: 'RZ-1' }] })
      .expect(200);
    expect(imported.body).toMatchObject({ created: 1, cardsCreated: 1, photosAdded: 1 });
    const card = await ctx.prisma.catalogProduct.findFirstOrThrow({
      where: { ean: '0859104005020' },
      include: { photo: { select: { contentType: true, sizeBytes: true } } },
    });
    expect(card.photo).toEqual({ contentType: 'image/png', sizeBytes: PNG.length });
    const ceneo = await send(CENEO, 'text/xml').expect(201);
    expect(ceneo.body.products[0]).toMatchObject({ key: '501', priceGrosze: 4550, stock: 3 });

    expectError((await send('x', 'image/png').expect(415)).body, 'UNSUPPORTED_FEED');
    expectError((await send('Nazwa;Cena\n;\n').expect(422)).body, 'FEED_EMPTY');
    const huge = ['SKU,Name,Price', ...Array.from({ length: 5001 }, (_, i) => `S${i},P${i},1`)];
    expectError((await send(huge.join('\n')).expect(413)).body, 'FEED_TOO_LARGE');
  });

  it('is for owners and managers of this salon only, and a file is kept for a day', async () => {
    const res = await send(CSV).expect(201);
    const staffUser = await signUp(ctx, 'kasia@example.com');
    const org = await ctx.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    await ctx.prisma.membership.create({
      data: {
        userId: staffUser.userId,
        organizationId: org.organizationId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    expectError((await send(CSV, 'text/csv', staffUser).expect(403)).body, 'FORBIDDEN');

    // Another salon cannot import from this salon's file.
    const other = await signUp(ctx, 'other@example.com');
    const second = await createOrgWithLocation(ctx, other, 'Inny');
    await ctx
      .http()
      .post(
        `/v1/organizations/${second.orgId}/locations/${second.locationId}/shop/integrations/feed/${res.body.feedId}/import`,
      )
      .set(other.auth)
      .send({ items: [{ key: 'GR-1' }] })
      .expect(404);

    await ctx.prisma.shopFeedUpload.updateMany({
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });
    await ctx
      .http()
      .post(`${feedBase}/${res.body.feedId}/import`)
      .set(owner.auth)
      .send({ items: [{ key: 'GR-1' }] })
      .expect(404);
  });
});
