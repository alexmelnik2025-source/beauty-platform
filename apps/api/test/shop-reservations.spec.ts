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
});
