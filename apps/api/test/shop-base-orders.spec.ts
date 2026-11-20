import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import { BaseOrdersService, MAX_ORDER_FAILS } from '../src/shop/integrations/base-orders.service';
import { ReservationsService } from '../src/shop/reservations.service';
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
 * Task Q4 (part 5): "Zamówienia do Base" — a product imported from the seller's Base and put aside
 * for a visit becomes an order in that Base; handing it over or the reservation ending moves the
 * order to the chosen status. Base is a stand-in (fetch is replaced): no real token is used.
 */

const TZ = 'Europe/Warsaw';
const TOKEN = '3001234-3005678-DEVONLYFAKETOKEN0000000000';
const CLIENT = {
  name: 'Anna Kowalska',
  phone: '+48 600 100 200',
  email: 'anna.client@example.com',
  locale: 'pl',
  acceptTerms: true,
};

let ctx: TestContext;
let owner: SignedInUser;
let staffUser: SignedInUser;
let slug: string;
let base: string;
let integrations: string;
let serviceId: string;
let staffId: string;
let day: string;
let pomadeId: string;

/** Calls Base received: [method, parameters]. */
let calls: [string, Record<string, unknown>][];
/** Make the next addOrder fail with a Base error. */
let failOrders: boolean;
let nextOrderId: number;
/** What getInventoryProductsList answers (the seller's catalogue in Base). */
let listed: Record<string, unknown>;

const BASE = {
  getInventories: {
    inventories: [
      {
        inventory_id: 307,
        name: 'Sklep GESTALT',
        price_groups: [105],
        default_price_group: 105,
        warehouses: ['bl_201'],
        default_warehouse: 'bl_201',
      },
    ],
  },
  getInventoryPriceGroups: {
    price_groups: [{ price_group_id: 105, name: 'Detal', currency: 'PLN' }],
  },
  getInventoryWarehouses: {
    warehouses: [{ warehouse_type: 'bl', warehouse_id: 201, name: 'Magazyn Wola' }],
  },
  getOrderStatusList: {
    statuses: [
      { id: 501, name: 'Nowe zamówienia', color: '#00f' },
      { id: 502, name: 'Do odbioru w salonie', color: '#0f0' },
      { id: 503, name: 'Odebrane', color: '#999' },
      { id: 504, name: 'Anulowane', color: '#f00' },
    ],
  },
  setOrderStatus: {},
} as Record<string, Record<string, unknown>>;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  calls = [];
  failOrders = false;
  nextOrderId = 7001;
  listed = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://api.baselinker.com/')) {
      throw new Error(`Unexpected fetch ${String(input)}`);
    }
    const form = new URLSearchParams(String(init?.body));
    const method = form.get('method') ?? '';
    calls.push([method, JSON.parse(form.get('parameters') ?? '{}')]);
    const json = (body: object) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (new Headers(init?.headers).get('X-BLToken') !== TOKEN) {
      return json({ status: 'ERROR', error_code: 'ERROR_BAD_TOKEN', error_message: 'Bad token' });
    }
    if (method === 'addOrder') {
      return failOrders
        ? json({ status: 'ERROR', error_code: 'ERROR_PRODUCT', error_message: 'Brak produktu' })
        : json({ status: 'SUCCESS', order_id: nextOrderId++ });
    }
    if (method === 'getInventoryProductsList') return json({ status: 'SUCCESS', products: listed });
    const answer = BASE[method];
    return answer
      ? json({ status: 'SUCCESS', ...answer })
      : json({ status: 'ERROR', error_code: 'ERROR_UNKNOWN_METHOD', error_message: method });
  });

  owner = await signUp(ctx, 'owner@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  slug = org.slug;
  base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
  integrations = `${base}/shop/integrations/base`;
  staffUser = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: staffUser.userId,
      organizationId: org.orgId,
      role: 'staff',
      locations: { create: [{ locationId: org.locationId }] },
    },
  });
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  staffId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [serviceId] })
      .expect(201)
  ).body.id;
  await ctx
    .http()
    .put(`${base}/staff/${staffId}/working-hours`)
    .set(owner.auth)
    .send({
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        intervals: [{ start: '09:00', end: '18:00' }],
      })),
    })
    .expect(200);
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);

  // Base connected, catalogue chosen, one product "imported" from it.
  await ctx.http().put(integrations).set(owner.auth).send({ token: TOKEN }).expect(200);
  await ctx
    .http()
    .patch(integrations)
    .set(owner.auth)
    .send({ inventoryId: '307', priceGroupId: '105', warehouseId: 'bl_201' })
    .expect(200);
  pomadeId = (
    await ctx
      .http()
      .post(`${base}/products`)
      .set(owner.auth)
      .send({ name: 'Reuzel Pink Pomade', priceGrosze: 6999, stockQuantity: 5, inSalonShop: true })
      .expect(201)
  ).body.id;
  await ctx.prisma.product.update({
    where: { id: pomadeId },
    data: { externalRef: 'base:307:9001', inSalonShop: true },
  });
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const shape = (name: string, body: unknown) =>
  expect(registeredResponseSchema(name).safeParse(body).error?.issues ?? []).toEqual([]);

const at = (hh: number) => new Date(zonedToInstant(day, hh * 60, TZ)).toISOString();

function lastCode(): string {
  const match = ctx.mail.lastTo(CLIENT.email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error('no code sent');
  return match[1];
}

/** Books online; returns the visit id and its "manage" token. */
async function book(hh: number) {
  const h = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start: at(hh) })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/code`)
    .send({ holdToken: h.body.holdToken, ...CLIENT })
    .expect(202);
  const c = await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/confirm`)
    .send({ holdToken: h.body.holdToken, code: lastCode() })
    .expect(200);
  return { id: c.body.appointment.id as string, token: c.body.manageToken as string };
}

const putAside = async (token: string, productId = pomadeId, quantity = 1) =>
  (
    await ctx
      .http()
      .post(`/v1/public/appointments/${token}/products`)
      .send({ productId, quantity })
      .expect(200)
  ).body.reservations as { id: string }[];

const turnOn = (body: object) =>
  ctx.http().put(`${integrations}/orders`).set(owner.auth).send(body);

/** One round of the scheduler; how many sellers sent something. */
const push = () => ctx.app.get(BaseOrdersService).pushDue();

const methods = () => calls.map((c) => c[0]);

describe('"Zamówienia do Base" (task Q4, part 5)', () => {
  it('lists the order statuses and takes only statuses of this Base, owners and managers only', async () => {
    const statuses = await ctx
      .http()
      .get(`${integrations}/order-statuses`)
      .set(owner.auth)
      .expect(200);
    shape('BaseOrderStatuses', statuses.body);
    expect(statuses.body.statuses[1]).toEqual({ id: '502', name: 'Do odbioru w salonie' });

    const before = await ctx.http().get(integrations).set(owner.auth).expect(200);
    shape('BaseIntegration', before.body);
    expect(before.body.orders).toEqual({
      enabled: false,
      newStatusId: null,
      handedStatusId: null,
      cancelledStatusId: null,
      failing: 0,
    });

    expectError((await turnOn({ enabled: true }).expect(400)).body, 'VALIDATION_ERROR');
    expectError(
      (await turnOn({ enabled: true, newStatusId: '999' }).expect(422)).body,
      'BASE_INVALID_CHOICE',
    );
    expectError(
      (
        await ctx
          .http()
          .put(`${integrations}/orders`)
          .set(staffUser.auth)
          .send({ enabled: false })
          .expect(403)
      ).body,
      'FORBIDDEN',
    );

    const on = await turnOn({
      enabled: true,
      newStatusId: '502',
      handedStatusId: '503',
      cancelledStatusId: '504',
    }).expect(200);
    shape('BaseIntegration', on.body);
    expect(on.body.orders).toMatchObject({
      enabled: true,
      newStatusId: '502',
      handedStatusId: '503',
      cancelledStatusId: '504',
    });

    // Turning it off keeps working without asking Base.
    calls = [];
    const off = await turnOn({ enabled: false }).expect(200);
    expect(off.body.orders.enabled).toBe(false);
    expect(calls).toEqual([]);
  });

  it('sends a product put aside as an order, then its handing over', async () => {
    const visit = await book(10);
    // Off: nothing goes to Base.
    await putAside(visit.token);
    expect(await push()).toBe(0);
    expect(methods()).toEqual([]);

    await turnOn({
      enabled: true,
      newStatusId: '502',
      handedStatusId: '503',
      cancelledStatusId: '504',
    }).expect(200);
    calls = [];
    // A product the salon added by hand (not from Base) never goes there.
    const own = (
      await ctx
        .http()
        .post(`${base}/products`)
        .set(owner.auth)
        .send({ name: 'Grzebień', priceGrosze: 1500, inSalonShop: true })
        .expect(201)
    ).body.id as string;
    await putAside(visit.token, own);

    expect(await push()).toBe(1);
    expect(methods()).toEqual(['addOrder']);
    const order = calls[0]?.[1] as Record<string, unknown>;
    expect(order).toMatchObject({
      order_status_id: 502,
      currency: 'PLN',
      paid: false,
      delivery_method: 'Odbiór w salonie',
      delivery_fullname: CLIENT.name,
      email: CLIENT.email,
      products: [
        expect.objectContaining({
          storage: 'db',
          product_id: '9001',
          name: 'Reuzel Pink Pomade',
          price_brutto: 69.99,
          quantity: 1,
          warehouse_id: 201,
        }),
      ],
    });
    expect(String(order.admin_comments)).toContain('Odbiór przy wizycie');
    const sent = await ctx.prisma.productReservation.findFirstOrThrow({
      where: { productId: pomadeId },
    });
    expect(sent).toMatchObject({ baseOrderId: '7001', baseOrderState: 'reserved' });
    expect(order.extra_field_1).toBe(sent.id);

    // Nothing new: nothing is sent again.
    calls = [];
    expect(await push()).toBe(0);
    expect(calls).toEqual([]);

    // The visit took place, the product is handed over: the order moves to "Odebrane".
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await ctx.prisma.appointment.update({
      where: { id: visit.id },
      data: {
        startAt: past,
        endAt: new Date(past.getTime() + 30 * 60_000),
        blockedUntil: new Date(past.getTime() + 30 * 60_000),
      },
    });
    const v = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: visit.id } });
    await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/status`)
      .set(owner.auth)
      .send({ version: v.version, status: 'completed' })
      .expect(200);
    await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/reservations/${sent.id}/hand-over`)
      .set(owner.auth)
      .expect(200);
    expect(await push()).toBe(1);
    expect(calls).toEqual([['setOrderStatus', { order_id: 7001, status_id: 503 }]]);
    expect(
      (await ctx.prisma.productReservation.findUniqueOrThrow({ where: { id: sent.id } }))
        .baseOrderState,
    ).toBe('handed');

    // The log shows the rounds that sent orders.
    const runs = await ctx.http().get(`${integrations}/runs`).set(owner.auth).expect(200);
    expect(runs.body.runs.filter((r: { trigger: string }) => r.trigger === 'orders')).toHaveLength(
      2,
    );
  });

  it('a reservation taken back, expired or on a cancelled visit cancels its order', async () => {
    await turnOn({ enabled: true, newStatusId: '502', cancelledStatusId: '504' }).expect(200);
    const first = await book(10);
    const second = await book(12);
    const third = await book(14);
    const [r1] = await putAside(first.token);
    await putAside(second.token);
    await putAside(third.token);
    calls = [];
    expect(await push()).toBe(1);
    expect(methods()).toEqual(['addOrder', 'addOrder', 'addOrder']);

    calls = [];
    // Taken back by the client.
    await ctx
      .http()
      .delete(`/v1/public/appointments/${first.token}/products/${r1?.id}`)
      .expect(200);
    // The visit cancelled.
    await ctx
      .http()
      .post(`/v1/public/appointments/${second.token}/cancel`)
      .set('Idempotency-Key', 'cancel-second')
      .send({})
      .expect(200);
    // Not picked up in time.
    const long = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    await ctx.prisma.appointment.update({
      where: { id: third.id },
      data: {
        startAt: long,
        endAt: new Date(long.getTime() + 30 * 60_000),
        blockedUntil: new Date(long.getTime() + 30 * 60_000),
      },
    });
    expect(await ctx.app.get(ReservationsService).expireOverdue()).toBe(1);

    expect(await push()).toBe(1);
    expect(calls.map(([m, p]) => [m, p.status_id])).toEqual([
      ['setOrderStatus', 504],
      ['setOrderStatus', 504],
      ['setOrderStatus', 504],
    ]);

    // A reservation that never reached Base and was cancelled is not sent at all.
    const fourth = await book(16);
    await putAside(fourth.token);
    await ctx
      .http()
      .post(`/v1/public/appointments/${fourth.token}/cancel`)
      .set('Idempotency-Key', 'cancel-fourth')
      .send({})
      .expect(200);
    calls = [];
    expect(await push()).toBe(0);
    expect(calls).toEqual([]);
  });

  it('without a status for the end, the order is left as it is in Base', async () => {
    await turnOn({ enabled: true, newStatusId: '502' }).expect(200);
    const visit = await book(10);
    const [r] = await putAside(visit.token);
    await push();
    calls = [];
    await ctx.http().delete(`/v1/public/appointments/${visit.token}/products/${r?.id}`).expect(200);
    expect(await push()).toBe(1);
    expect(calls).toEqual([]);
    expect(
      (await ctx.prisma.productReservation.findUniqueOrThrow({ where: { id: r?.id } }))
        .baseOrderState,
    ).toBe('cancelled');
  });

  it('a failing order is tried a few times, shown in the status, and again on "Synchronizuj teraz"', async () => {
    await turnOn({ enabled: true, newStatusId: '502' }).expect(200);
    const visit = await book(10);
    await putAside(visit.token);
    failOrders = true;
    for (let i = 0; i < MAX_ORDER_FAILS + 2; i += 1) await push();
    expect(methods().filter((m) => m === 'addOrder')).toHaveLength(MAX_ORDER_FAILS);
    const row = await ctx.prisma.productReservation.findFirstOrThrow();
    expect(row).toMatchObject({ baseOrderId: null, baseOrderFails: MAX_ORDER_FAILS });
    expect(row.baseOrderError).toContain('Brak produktu');

    const status = await ctx.http().get(integrations).set(owner.auth).expect(200);
    expect(status.body.orders.failing).toBe(1);
    const runs = await ctx.http().get(`${integrations}/runs`).set(owner.auth).expect(200);
    expect(runs.body.runs[0]).toMatchObject({
      trigger: 'orders',
      changed: 0,
      errorCode: 'BASE_ERROR',
    });

    // Base fixed: "Synchronizuj teraz" sends it before renewing stock.
    failOrders = false;
    calls = [];
    await ctx.http().post(`${integrations}/sync`).set(owner.auth).expect(200);
    expect(methods()[0]).toBe('addOrder');
    expect(await ctx.prisma.productReservation.findFirstOrThrow()).toMatchObject({
      baseOrderId: '7001',
      baseOrderFails: 0,
      baseOrderError: null,
    });
    expect(
      (await ctx.http().get(integrations).set(owner.auth).expect(200)).body.orders.failing,
    ).toBe(0);
  });

  it('the stock read from Base keeps the pieces of our open orders, which Base already took off', async () => {
    await turnOn({ enabled: true, newStatusId: '502', handedStatusId: '503' }).expect(200);
    const visit = await book(10);
    await putAside(visit.token, pomadeId, 2);
    expect(await push()).toBe(1);

    // Base lowered its stock 5 → 3 for our order; the salon still has 5 pieces, 2 of them put
    // aside, so clients see 3 left — not 1.
    listed = {
      '9001': {
        id: 9001,
        name: 'Reuzel Pink Pomade',
        prices: { '105': 69.99 },
        stock: { bl_201: 3 },
      },
    };
    await ctx.http().post(`${integrations}/sync`).set(owner.auth).expect(200);
    expect(
      (await ctx.prisma.product.findUniqueOrThrow({ where: { id: pomadeId } })).stockQuantity,
    ).toBe(5);
    expect(await ctx.app.get(ReservationsService).availableToReserve(pomadeId, 5)).toBe(3);

    // Handed over: the sale takes one piece off here, the order is closed in Base; Base keeps 3.
    const reservation = await ctx.prisma.productReservation.findFirstOrThrow();
    await ctx.prisma.productReservation.update({
      where: { id: reservation.id },
      data: { status: 'handed', baseOrderState: 'handed' },
    });
    await ctx.prisma.shopIntegration.updateMany({ data: { lastSyncAt: null } });
    await ctx.http().post(`${integrations}/sync`).set(owner.auth).expect(200);
    expect(
      (await ctx.prisma.product.findUniqueOrThrow({ where: { id: pomadeId } })).stockQuantity,
    ).toBe(3);
  });
});
