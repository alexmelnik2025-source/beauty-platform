import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
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
 * Task Q3 (part 4): "Odbiorę przy wizycie" — a product put aside for a visit by the visit link,
 * handed over and sold at the visit by the salon; what it does to availability.
 */

const TZ = 'Europe/Warsaw';
const CLIENT = {
  name: 'Anna Kowalska',
  phone: '+48 600 100 200',
  email: 'anna.client@example.com',
  locale: 'pl',
  acceptTerms: true,
};

let ctx: TestContext;
let owner: SignedInUser;
let slug: string;
let base: string;
let serviceId: string;
let staffId: string;
let day: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  slug = org.slug;
  base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
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

const product = async (body: object) =>
  (await ctx.http().post(`${base}/products`).set(owner.auth).send(body).expect(201)).body as {
    id: string;
  };

/** The visit took place: moved into the past and marked "came". */
async function came(appointmentId: string) {
  const past = new Date(Date.now() - 2 * 60 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      startAt: past,
      endAt: new Date(past.getTime() + 30 * 60_000),
      blockedUntil: new Date(past.getTime() + 30 * 60_000),
    },
  });
  const visit = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  await ctx
    .http()
    .post(`${base}/appointments/${appointmentId}/status`)
    .set(owner.auth)
    .send({ version: visit.version, status: 'completed' })
    .expect(200);
}

describe('products put aside for a visit (task Q3, part 4)', () => {
  it('the client puts a product aside by the visit link, the salon hands it over as a sale', async () => {
    const pomade = await product({
      name: 'Pomada',
      priceGrosze: 5900,
      stockQuantity: 2,
      inSalonShop: true,
    });
    const hidden = await product({ name: 'Szampon (magazyn)', priceGrosze: 2000 });
    const visit = await book(10);

    const before = await ctx
      .http()
      .get(`/v1/public/appointments/${visit.token}/products`)
      .expect(200);
    shape('VisitProducts', before.body);
    expect(before.body).toMatchObject({
      currency: 'PLN',
      canChange: true,
      reservations: [],
      totalGrosze: 0,
    });
    // Only what the salon shows to clients may be put aside.
    expect(before.body.available.map((p: { id: string }) => p.id)).toEqual([pomade.id]);
    await ctx
      .http()
      .post(`/v1/public/appointments/${visit.token}/products`)
      .send({ productId: hidden.id })
      .expect(404);

    const reserved = await ctx
      .http()
      .post(`/v1/public/appointments/${visit.token}/products`)
      .send({ productId: pomade.id, quantity: 2 })
      .expect(200);
    expect(reserved.body.reservations).toEqual([
      expect.objectContaining({
        productId: pomade.id,
        name: 'Pomada',
        quantity: 2,
        unitPriceGrosze: 5900,
        totalGrosze: 11800,
        status: 'reserved',
      }),
    ]);
    expect(reserved.body.totalGrosze).toBe(11800);
    // Both pieces are spoken for: nothing left for other clients, the stock itself unchanged.
    expect(reserved.body.available[0].available).toBe(false);
    const page = await ctx.http().get(`/v1/public/locations/${slug}/products`).expect(200);
    expect(page.body.products[0]).toMatchObject({ id: pomade.id, available: false });
    const stock = await ctx.http().get(`${base}/products`).set(owner.auth).expect(200);
    expect(stock.body.products.find((p: { id: string }) => p.id === pomade.id).stockQuantity).toBe(
      2,
    );
    const other = await book(12);
    const none = await ctx
      .http()
      .post(`/v1/public/appointments/${other.token}/products`)
      .send({ productId: pomade.id })
      .expect(409);
    expectError(none.body, 'OUT_OF_STOCK');

    // The salon sees it in the visit card; a specialist cannot hand it over before the visit took place.
    const card = await ctx
      .http()
      .get(`${base}/appointments/${visit.id}/reservations`)
      .set(owner.auth)
      .expect(200);
    shape('VisitReservations', card.body);
    expect(card.body.toHandGrosze).toBe(11800);
    const reservationId = card.body.reservations[0].id as string;
    const early = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/reservations/${reservationId}/hand-over`)
      .set(owner.auth)
      .expect(409);
    expectError(early.body, 'NOT_COMPLETED');

    // The visit took place: handed over = the usual sale, the pieces leave the stock.
    await came(visit.id);
    const handed = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/reservations/${reservationId}/hand-over`)
      .set(owner.auth)
      .expect(200);
    expect(handed.body.reservations[0]).toMatchObject({ status: 'handed' });
    expect(handed.body.toHandGrosze).toBe(0);
    const sales = await ctx
      .http()
      .get(`${base}/appointments/${visit.id}/products`)
      .set(owner.auth)
      .expect(200);
    expect(sales.body.sales).toEqual([
      expect.objectContaining({ productId: pomade.id, quantity: 2, unitPriceGrosze: 5900 }),
    ]);
    const after = await ctx.http().get(`${base}/products`).set(owner.auth).expect(200);
    expect(after.body.products.find((p: { id: string }) => p.id === pomade.id).stockQuantity).toBe(
      0,
    );
    const twice = await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/reservations/${reservationId}/hand-over`)
      .set(owner.auth)
      .expect(409);
    expectError(twice.body, 'NOT_RESERVED');
    // After the visit the client can no longer change anything by the link.
    const later = await ctx
      .http()
      .get(`/v1/public/appointments/${visit.token}/products`)
      .expect(200);
    expect(later.body).toMatchObject({ canChange: false, available: [] });
    expect(later.body.reservations[0].status).toBe('handed');
    const tooLate = await ctx
      .http()
      .post(`/v1/public/appointments/${visit.token}/products`)
      .send({ productId: pomade.id })
      .expect(409);
    expectError(tooLate.body, 'TOO_LATE_TO_CHANGE');
  });

  it('taking a product back, a cancelled visit and an overdue pickup free the pieces', async () => {
    const wax = await product({
      name: 'Wosk',
      priceGrosze: 3000,
      stockQuantity: 1,
      inSalonShop: true,
    });
    const first = await book(10);
    const second = await book(12);
    const r1 = await ctx
      .http()
      .post(`/v1/public/appointments/${first.token}/products`)
      .send({ productId: wax.id })
      .expect(200);
    const reservationId = r1.body.reservations[0].id as string;
    await ctx
      .http()
      .post(`/v1/public/appointments/${second.token}/products`)
      .send({ productId: wax.id })
      .expect(409);

    // The client takes it back: the piece is free for the next client.
    const back = await ctx
      .http()
      .delete(`/v1/public/appointments/${first.token}/products/${reservationId}`)
      .expect(200);
    expect(back.body.reservations).toEqual([]);
    await ctx
      .http()
      .delete(`/v1/public/appointments/${first.token}/products/${reservationId}`)
      .expect(404);
    const r2 = await ctx
      .http()
      .post(`/v1/public/appointments/${second.token}/products`)
      .send({ productId: wax.id })
      .expect(200);
    expect(r2.body.reservations).toHaveLength(1);

    // The second client cancels the visit: its reservation no longer holds the piece.
    await ctx
      .http()
      .post(`/v1/public/appointments/${second.token}/cancel`)
      .set('Idempotency-Key', 'cancel-second')
      .send({})
      .expect(200);
    const page = await ctx.http().get(`/v1/public/locations/${slug}/products`).expect(200);
    expect(page.body.products[0].available).toBe(true);

    // The salon takes a waiting product back too.
    const third = await book(14);
    const r3 = await ctx
      .http()
      .post(`/v1/public/appointments/${third.token}/products`)
      .send({ productId: wax.id })
      .expect(200);
    const salonCancel = await ctx
      .http()
      .post(`${base}/appointments/${third.id}/reservations/${r3.body.reservations[0].id}/cancel`)
      .set(owner.auth)
      .expect(200);
    expect(salonCancel.body.reservations[0].status).toBe('cancelled');

    // Not picked up within the salon's days after the visit: expired by the timer.
    const fourth = await book(16);
    await ctx
      .http()
      .post(`/v1/public/appointments/${fourth.token}/products`)
      .send({ productId: wax.id })
      .expect(200);
    const service = ctx.app.get(ReservationsService);
    expect(await service.expireOverdue()).toBe(0);
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60_000);
    await ctx.prisma.appointment.update({
      where: { id: fourth.id },
      data: {
        startAt: longAgo,
        endAt: new Date(longAgo.getTime() + 30 * 60_000),
        blockedUntil: new Date(longAgo.getTime() + 30 * 60_000),
      },
    });
    expect(await service.expireOverdue()).toBe(1);
    const expired = await ctx
      .http()
      .get(`${base}/appointments/${fourth.id}/reservations`)
      .set(owner.auth)
      .expect(200);
    expect(expired.body.reservations[0].status).toBe('expired');
    const free = await ctx.http().get(`/v1/public/locations/${slug}/products`).expect(200);
    expect(free.body.products[0].available).toBe(true);
  });

  it('two clients at once get the last piece only once; the stock and price are read under the lock (604)', async () => {
    const oil = await product({
      name: 'Olejek',
      priceGrosze: 4000,
      stockQuantity: 1,
      inSalonShop: true,
    });
    const first = await book(10);
    const second = await book(12);
    const results = await Promise.all(
      [first, second].map((v) =>
        ctx.http().post(`/v1/public/appointments/${v.token}/products`).send({ productId: oil.id }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expectError(results.find((r) => r.status === 409)?.body, 'OUT_OF_STOCK');

    // The salon raised the price and the stock a moment ago: a new reservation takes the current
    // price, and the second client now finds a piece.
    await ctx
      .http()
      .patch(`${base}/products/${oil.id}`)
      .set(owner.auth)
      .send({ priceGrosze: 4500, stockQuantity: 2 })
      .expect(200);
    const loser = results.find((r) => r.status === 409) === results[0] ? first : second;
    const later = await ctx
      .http()
      .post(`/v1/public/appointments/${loser.token}/products`)
      .send({ productId: oil.id })
      .expect(200);
    expect(later.body.reservations[0]).toMatchObject({ unitPriceGrosze: 4500, status: 'reserved' });
    expect(later.body.available[0].available).toBe(false);
  });

  it('a product moved to a new visit stops waiting on the cancelled one (605)', async () => {
    const wax = await product({
      name: 'Wosk',
      priceGrosze: 3000,
      stockQuantity: 1,
      inSalonShop: true,
    });
    const old = await book(10);
    await ctx
      .http()
      .post(`/v1/public/appointments/${old.token}/products`)
      .send({ productId: wax.id })
      .expect(200);
    await ctx
      .http()
      .post(`/v1/public/appointments/${old.token}/cancel`)
      .set('Idempotency-Key', 'cancel-old')
      .send({})
      .expect(200);
    // The cancelled visit still shows the waiting product — the page offers to move it.
    const offered = await ctx
      .http()
      .get(`/v1/public/appointments/${old.token}/products`)
      .expect(200);
    expect(offered.body.reservations).toEqual([expect.objectContaining({ status: 'reserved' })]);

    // "Przenieść produkty na nowy termin?" → a new visit with the product put aside.
    const fresh = await book(12);
    const moved = await ctx
      .http()
      .post(`/v1/public/appointments/${fresh.token}/products`)
      .send({ productId: wax.id })
      .expect(200);
    expect(moved.body.reservations).toEqual([expect.objectContaining({ status: 'reserved' })]);
    // The old visit no longer offers it — neither to the client nor in the salon's card.
    const settled = await ctx
      .http()
      .get(`/v1/public/appointments/${old.token}/products`)
      .expect(200);
    expect(settled.body.reservations).toEqual([]);
    const card = await ctx
      .http()
      .get(`${base}/appointments/${old.id}/reservations`)
      .set(owner.auth)
      .expect(200);
    expect(card.body.reservations.map((r: { status: string }) => r.status)).toEqual(['cancelled']);
    expect(card.body.toHandGrosze).toBe(0);
    // The piece is held once, by the new visit.
    const page = await ctx.http().get(`/v1/public/locations/${slug}/products`).expect(200);
    expect(page.body.products[0].available).toBe(false);
  });
});

async function signIn(email: string): Promise<{ Authorization: string }> {
  await ctx.http().post('/v1/client/auth/code').send({ email, locale: 'pl' }).expect(202);
  const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code sent to ${email}`);
  const res = await ctx
    .http()
    .post('/v1/client/auth/verify')
    .send({ email, code: match[1], clientType: 'mobile' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

describe('"Produkty do odbioru" in the client app (task Q3)', () => {
  it('the signed-in client puts a product aside for their visit and takes it back', async () => {
    const pomade = await product({
      name: 'Pomada',
      priceGrosze: 5900,
      stockQuantity: 2,
      inSalonShop: true,
    });
    const visit = await book(10);
    const me = await signIn(CLIENT.email);
    const url = `/v1/client/appointments/${visit.id}/products`;

    const before = await ctx.http().get(url).set(me).expect(200);
    shape('VisitProducts', before.body);
    expect(before.body.canChange).toBe(true);
    expect(before.body.available.map((p: { id: string }) => p.id)).toEqual([pomade.id]);

    const put = await ctx
      .http()
      .post(url)
      .set(me)
      .send({ productId: pomade.id, quantity: 2 })
      .expect(200);
    shape('VisitProducts', put.body);
    expect(put.body.reservations).toHaveLength(1);
    expect(put.body.totalGrosze).toBe(11800);
    // The same reservation is seen by the visit link and by the salon.
    const byLink = await ctx
      .http()
      .get(`/v1/public/appointments/${visit.token}/products`)
      .expect(200);
    expect(byLink.body.reservations[0].id).toBe(put.body.reservations[0].id);
    const salon = await ctx
      .http()
      .get(`${base}/appointments/${visit.id}/reservations`)
      .set(owner.auth)
      .expect(200);
    expect(salon.body.toHandGrosze).toBe(11800);
    // No piece is left for anyone else.
    const none = await ctx
      .http()
      .post(url)
      .set(me)
      .send({ productId: pomade.id, quantity: 1 })
      .expect(409);
    expectError(none.body, 'OUT_OF_STOCK');

    const back = await ctx
      .http()
      .delete(`${url}/${put.body.reservations[0].id}`)
      .set(me)
      .expect(200);
    expect(back.body.reservations).toHaveLength(0);
    expect(back.body.totalGrosze).toBe(0);
  });

  it("someone else's visit looks missing; a started visit cannot change", async () => {
    const pomade = await product({
      name: 'Pomada',
      priceGrosze: 5900,
      stockQuantity: 5,
      inSalonShop: true,
    });
    const visit = await book(11);
    const stranger = await signIn('someone.else@example.com');
    const url = `/v1/client/appointments/${visit.id}/products`;
    await ctx.http().get(url).set(stranger).expect(404);
    await ctx
      .http()
      .post(url)
      .set(stranger)
      .send({ productId: pomade.id, quantity: 1 })
      .expect(404);
    await ctx.http().get(url).expect(401);
    await ctx.http().get('/v1/client/appointments/not-a-uuid/products').set(stranger).expect(404);

    const me = await signIn(CLIENT.email);
    // A product the salon does not show to clients cannot be put aside.
    const hidden = await product({ name: 'Wosk', priceGrosze: 4500, stockQuantity: 5 });
    await ctx.http().post(url).set(me).send({ productId: hidden.id, quantity: 1 }).expect(404);
    await came(visit.id);
    const late = await ctx
      .http()
      .post(url)
      .set(me)
      .send({ productId: pomade.id, quantity: 1 })
      .expect(409);
    expectError(late.body, 'TOO_LATE_TO_CHANGE');
    const after = await ctx.http().get(url).set(me).expect(200);
    expect(after.body.canChange).toBe(false);
    expect(after.body.available).toEqual([]);
  });
});

describe('"Jak było?": put aside for the next visit what was used (task Q3, screen C)', () => {
  const sell = (visitId: string, productId: string) =>
    ctx
      .http()
      .post(`${base}/appointments/${visitId}/products`)
      .set(owner.auth)
      .send({ productId, quantity: 1 })
      .expect(201);

  it('lists what was used at the visit and puts it aside on the next visit, once', async () => {
    const pomade = await product({
      name: 'Pomada',
      priceGrosze: 5900,
      stockQuantity: 3,
      inSalonShop: true,
    });
    const wax = await product({ name: 'Wosk (tylko salon)', priceGrosze: 3000, stockQuantity: 5 });
    const other = await product({ name: 'Olejek', priceGrosze: 4000, inSalonShop: true });
    const visit = await book(10);

    // Before the visit took place nothing was used.
    const ahead = await ctx
      .http()
      .get(`/v1/public/appointments/${visit.token}/products/used`)
      .expect(200);
    expect(ahead.body.products).toEqual([]);

    await came(visit.id);
    await sell(visit.id, pomade.id);
    await sell(visit.id, wax.id);
    await sell(visit.id, pomade.id);

    const used = await ctx
      .http()
      .get(`/v1/public/appointments/${visit.token}/products/used`)
      .expect(200);
    shape('UsedProducts', used.body);
    // Once each, only what the salon shows to clients, at today's price.
    expect(used.body).toEqual({
      currency: 'PLN',
      products: [
        {
          id: pomade.id,
          name: 'Pomada',
          brand: null,
          priceGrosze: 5900,
          photoId: null,
          available: true,
          reservedForNext: false,
        },
      ],
      nextVisit: null,
      rebook: { serviceId, staffId },
    });
    const none = await ctx
      .http()
      .post(`/v1/public/appointments/${visit.token}/products/next`)
      .send({ productId: pomade.id })
      .expect(409);
    expectError(none.body, 'NO_NEXT_VISIT');

    // "Umów kolejną wizytę": the same client books again.
    const next = await book(12);
    const withNext = await ctx
      .http()
      .get(`/v1/public/appointments/${visit.token}/products/used`)
      .expect(200);
    expect(withNext.body.nextVisit).toEqual({ date: day, time: '12:00', staffName: 'Kasia' });

    const saved = await ctx
      .http()
      .post(`/v1/public/appointments/${visit.token}/products/next`)
      .send({ productId: pomade.id })
      .expect(200);
    shape('UsedProducts', saved.body);
    expect(saved.body.products[0].reservedForNext).toBe(true);
    await ctx
      .http()
      .post(`/v1/public/appointments/${visit.token}/products/next`)
      .send({ productId: pomade.id })
      .expect(200);
    const onNext = await ctx
      .http()
      .get(`/v1/public/appointments/${next.token}/products`)
      .expect(200);
    expect(onNext.body.reservations).toEqual([
      expect.objectContaining({ productId: pomade.id, quantity: 1, status: 'reserved' }),
    ]);

    // Only a product used at this visit and shown to clients.
    for (const productId of [wax.id, other.id]) {
      await ctx
        .http()
        .post(`/v1/public/appointments/${visit.token}/products/next`)
        .send({ productId })
        .expect(404);
    }
  });

  it("another client's visit is not 'the next one'", async () => {
    const pomade = await product({ name: 'Pomada', priceGrosze: 5900, inSalonShop: true });
    const visit = await book(10);
    await came(visit.id);
    await sell(visit.id, pomade.id);
    const h = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start: at(14) })
      .expect(201);
    const someoneElse = {
      ...CLIENT,
      name: 'Jan Nowak',
      phone: '+48 600 300 400',
      email: 'jan@example.com',
    };
    await ctx
      .http()
      .post(`/v1/public/holds/${h.body.holdId}/code`)
      .send({ holdToken: h.body.holdToken, ...someoneElse })
      .expect(202);
    const code = ctx.mail.lastTo(someoneElse.email)?.text.match(/\b(\d{6})\b/)?.[1];
    await ctx
      .http()
      .post(`/v1/public/holds/${h.body.holdId}/confirm`)
      .send({ holdToken: h.body.holdToken, code })
      .expect(200);
    const used = await ctx
      .http()
      .get(`/v1/public/appointments/${visit.token}/products/used`)
      .expect(200);
    expect(used.body.nextVisit).toBeNull();
  });
});

describe('"Na wizycie użyto" in the client app (task Q3, screen C)', () => {
  it('the signed-in client puts aside on their next visit what was used', async () => {
    const pomade = await product({ name: 'Pomada', priceGrosze: 5900, inSalonShop: true });
    const visit = await book(10);
    await came(visit.id);
    await ctx
      .http()
      .post(`${base}/appointments/${visit.id}/products`)
      .set(owner.auth)
      .send({ productId: pomade.id, quantity: 1 })
      .expect(201);
    const next = await book(12);
    const me = await signIn(CLIENT.email);
    const url = `/v1/client/appointments/${visit.id}/products`;

    const used = await ctx.http().get(`${url}/used`).set(me).expect(200);
    shape('UsedProducts', used.body);
    expect(used.body.products.map((p: { id: string }) => p.id)).toEqual([pomade.id]);
    expect(used.body.nextVisit).toMatchObject({ time: '12:00', staffName: 'Kasia' });
    const saved = await ctx
      .http()
      .post(`${url}/next`)
      .set(me)
      .send({ productId: pomade.id })
      .expect(200);
    expect(saved.body.products[0].reservedForNext).toBe(true);
    const onNext = await ctx
      .http()
      .get(`/v1/client/appointments/${next.id}/products`)
      .set(me)
      .expect(200);
    expect(onNext.body.reservations).toHaveLength(1);

    // Someone else's visit looks missing.
    const stranger = await signIn('stranger@example.com');
    await ctx.http().get(`${url}/used`).set(stranger).expect(404);
    await ctx.http().post(`${url}/next`).set(stranger).send({ productId: pomade.id }).expect(404);
  });
});
