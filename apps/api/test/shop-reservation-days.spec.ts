import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import { ReservationsService } from '../src/shop/reservations.service';
import {
  createOrgWithLocation,
  createTestApp,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Task Q3: "Jak długo czekają odłożone produkty" — the salon's `shopReservationDays` (1–90, 14 by
 * default) set from "Mój sklep": only the owner or the manager changes it, and a product put
 * aside expires that many days after the visit.
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
let orgId: string;
let locationId: string;

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
  orgId = org.orgId;
  locationId = org.locationId;
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

async function addMember(email: string, role: 'staff' | 'manager') {
  const member = await signUp(ctx, email);
  await ctx.prisma.membership.create({
    data: {
      userId: member.userId,
      organizationId: orgId,
      role,
      locations: { create: [{ locationId }] },
    },
  });
  return member;
}

const setDays = async (auth: Record<string, string>, shopReservationDays: unknown) => {
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  return ctx.http().patch(base).set(auth).send({ version: loc.body.version, shopReservationDays });
};

/** The visit was `daysAgo` days ago. */
async function movePast(appointmentId: string, daysAgo: number) {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      startAt: past,
      endAt: new Date(past.getTime() + 30 * 60_000),
      blockedUntil: new Date(past.getTime() + 30 * 60_000),
    },
  });
}

describe('how long a product put aside waits (task Q3)', () => {
  it('14 days by default; the owner and the manager change it within 1–90, a specialist cannot', async () => {
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(loc.body.shopReservationDays).toBe(14);

    const saved = await setDays(owner.auth, 3);
    expect(saved.status).toBe(200);
    expect(saved.body.shopReservationDays).toBe(3);

    for (const bad of [0, 91, 2.5, '7']) {
      const res = await setDays(owner.auth, bad);
      expect(res.status).toBe(400);
    }

    const manager = await addMember('manager@example.com', 'manager');
    expect((await setDays(manager.auth, 30)).body.shopReservationDays).toBe(30);

    const staff = await addMember('staff@example.com', 'staff');
    const denied = await setDays(staff.auth, 60);
    expect(denied.status).toBe(403);
    // The specialist still reads the number ("Mój sklep" shows it without the field).
    const seen = await ctx.http().get(base).set(staff.auth).expect(200);
    expect(seen.body.shopReservationDays).toBe(30);
  });

  it("a product put aside expires the salon's number of days after the visit", async () => {
    const pomade = await product({
      name: 'Pomada',
      priceGrosze: 5900,
      stockQuantity: 1,
      inSalonShop: true,
    });
    const visit = await book(10);
    await ctx
      .http()
      .post(`/v1/public/appointments/${visit.token}/products`)
      .send({ productId: pomade.id })
      .expect(200);
    await movePast(visit.id, 5);
    const service = ctx.app.get(ReservationsService);

    // 14 days by default: 5 days after the visit it still waits.
    expect(await service.expireOverdue()).toBe(0);
    // The salon shortens the wait to 7 days: still waiting.
    expect((await setDays(owner.auth, 7)).status).toBe(200);
    expect(await service.expireOverdue()).toBe(0);
    // 3 days: overdue, the piece is free for other clients again.
    expect((await setDays(owner.auth, 3)).status).toBe(200);
    expect(await service.expireOverdue()).toBe(1);
    const card = await ctx
      .http()
      .get(`${base}/appointments/${visit.id}/reservations`)
      .set(owner.auth)
      .expect(200);
    expect(card.body.reservations[0].status).toBe('expired');
    const page = await ctx.http().get(`/v1/public/locations/${slug}/products`).expect(200);
    expect(page.body.products[0]).toMatchObject({ id: pomade.id, available: true });
  });
});
