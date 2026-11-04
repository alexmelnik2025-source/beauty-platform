import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
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
 * Task 62 (owner, 04.11.2026): "each specialist's service may cost differently — Marek 80,
 * Ilia 120 — or the same for everyone". The service keeps a base price; a specialist may
 * have an own one. New visits take the price of their specialist; booked visits keep theirs.
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
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let haircutId: string;
let marek: string;
let ilia: string;
let ola: string;
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

const setPrices = (prices: { staffId: string; priceGrosze: number | null }[], auth = owner.auth) =>
  ctx.http().put(`${base}/services/${haircutId}/staff-prices`).set(auth).send({ prices });

async function bookOnline(start: string, staffId?: string): Promise<string> {
  const h = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId: haircutId, start, ...(staffId ? { staffId } : {}) })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/code`)
    .send({ holdToken: h.body.holdToken, ...CLIENT })
    .expect(202);
  const code = ctx.mail.lastTo(CLIENT.email)?.text.match(/\b(\d{6})\b/)?.[1];
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/confirm`)
    .send({ holdToken: h.body.holdToken, code })
    .expect(200);
  return h.body.holdId;
}

const visit = (id: string) => ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  haircutId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 10000 })
      .expect(201)
  ).body.id;
  const ids: string[] = [];
  for (const name of ['Marek', 'Ilia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [haircutId] })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${staff.body.id}/working-hours`)
      .set(owner.auth)
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      })
      .expect(200);
    ids.push(staff.body.id);
  }
  [marek, ilia, ola] = ids as [string, string, string];
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

describe("each specialist's own price", () => {
  it('the owner sets them; clients see each price and the range', async () => {
    const res = await setPrices([
      { staffId: marek, priceGrosze: 8000 },
      { staffId: ilia, priceGrosze: 12000 },
    ]).expect(200);
    expect(registeredResponseSchema('StaffPrices').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.prices).toHaveLength(2);
    const listed = await ctx.http().get(`${base}/staff-prices`).set(owner.auth).expect(200);
    expect(listed.body).toEqual(res.body);

    const pub = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(
      registeredResponseSchema('PublicLocation').safeParse(pub.body).error?.issues ?? [],
    ).toEqual([]);
    expect(pub.body.services[0]).toMatchObject({
      priceGrosze: 10000,
      priceFromGrosze: 8000,
      priceToGrosze: 12000,
    });
    const priceOf = (name: string) =>
      pub.body.staff.find((s: { displayName: string }) => s.displayName === name).prices[0]
        .priceGrosze;
    expect([priceOf('Marek'), priceOf('Ilia'), priceOf('Ola')]).toEqual([8000, 12000, 10000]);
  });

  it('a booked visit takes its specialist’s price and keeps it after the price changes', async () => {
    await setPrices([
      { staffId: marek, priceGrosze: 8000 },
      { staffId: ilia, priceGrosze: 12000 },
    ]).expect(200);
    const withIlia = await bookOnline(at(day, 10), ilia);
    expect((await visit(withIlia)).priceGrosze).toBe(12000);
    const withOla = await bookOnline(at(day, 11), ola);
    expect((await visit(withOla)).priceGrosze).toBe(10000);

    // By the salon, with Marek.
    const manual = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: marek,
        start: at(day, 12),
        customer: { name: 'Jan Nowak', phone: '+48600000002' },
      })
      .expect(201);
    expect(manual.body.priceGrosze).toBe(8000);

    // "Any specialist": the price of the one who gets the visit.
    const any = await visit(await bookOnline(at(day, 14)));
    const expected = { [marek]: 8000, [ilia]: 12000, [ola]: 10000 }[any.staffId];
    expect(any.priceGrosze).toBe(expected);

    // A new price does not change booked visits.
    await setPrices([{ staffId: ilia, priceGrosze: 15000 }]).expect(200);
    expect((await visit(withIlia)).priceGrosze).toBe(12000);
    const later = await bookOnline(at(day, 15), ilia);
    expect((await visit(later)).priceGrosze).toBe(15000);
    // Marek is back on the service price.
    const listed = await ctx.http().get(`${base}/staff-prices`).set(owner.auth).expect(200);
    expect(listed.body.prices).toEqual([
      { serviceId: haircutId, staffId: ilia, priceGrosze: 15000 },
    ]);
  });

  it('changing who performs the service keeps the prices of those who stay', async () => {
    await setPrices([
      { staffId: marek, priceGrosze: 8000 },
      { staffId: ilia, priceGrosze: 12000 },
    ]).expect(200);
    await ctx
      .http()
      .put(`${base}/services/${haircutId}/staff`)
      .set(owner.auth)
      .send({ staffIds: [marek, ola] })
      .expect(200);
    await ctx
      .http()
      .put(`${base}/staff/${ola}/services`)
      .set(owner.auth)
      .send({ serviceIds: [haircutId] })
      .expect(200);
    const listed = await ctx.http().get(`${base}/staff-prices`).set(owner.auth).expect(200);
    expect(listed.body.prices).toEqual([
      { serviceId: haircutId, staffId: marek, priceGrosze: 8000 },
    ]);
  });

  it('only for specialists who perform it; only owners and managers', async () => {
    await ctx
      .http()
      .put(`${base}/services/${haircutId}/staff`)
      .set(owner.auth)
      .send({ staffIds: [marek] })
      .expect(200);
    expectError(
      (await setPrices([{ staffId: ilia, priceGrosze: 5000 }]).expect(400)).body,
      'VALIDATION_ERROR',
    );
    expectError(
      (
        await setPrices([
          { staffId: marek, priceGrosze: 5000 },
          { staffId: marek, priceGrosze: 6000 },
        ]).expect(400)
      ).body,
      'VALIDATION_ERROR',
    );
    expect((await setPrices([{ staffId: marek, priceGrosze: -1 }])).status).toBe(400);

    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    expect((await setPrices([{ staffId: marek, priceGrosze: 1 }], kasia.auth)).status).toBe(403);
    // A specialist sees the prices.
    await ctx.http().get(`${base}/staff-prices`).set(kasia.auth).expect(200);

    const log = await ctx.prisma.auditLog.findFirst({
      where: { action: 'service.staff_prices_set' },
    });
    expect(log).toBeNull();
    await setPrices([{ staffId: marek, priceGrosze: 7000 }]).expect(200);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'service.staff_prices_set' } })).toBe(
      1,
    );
  });
});

describe("each specialist's own duration (task 70)", () => {
  const setDurations = (
    durations: { staffId: string; durationMinutes: number | null }[],
    auth = owner.auth,
  ) =>
    ctx.http().put(`${base}/services/${haircutId}/staff-durations`).set(auth).send({ durations });

  const freeTimes = async (query: string): Promise<{ time: string; staffIds: string[] }[]> =>
    (
      await ctx
        .http()
        .get(
          `/v1/public/locations/${slug}/availability?serviceId=${haircutId}&from=${day}&to=${day}${query}`,
        )
        .expect(200)
    ).body.slots;

  it('free times, holds and visits use the specialist’s own duration', async () => {
    const res = await setDurations([{ staffId: ilia, durationMinutes: 60 }]).expect(200);
    expect(registeredResponseSchema('StaffPrices').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.durations).toEqual([
      { serviceId: haircutId, staffId: ilia, durationMinutes: 60 },
    ]);
    expect(res.body.prices).toEqual([]);

    const pub = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(
      registeredResponseSchema('PublicLocation').safeParse(pub.body).error?.issues ?? [],
    ).toEqual([]);
    expect(pub.body.services[0]).toMatchObject({
      durationMinutes: 30,
      durationFromMinutes: 30,
      durationToMinutes: 60,
    });
    const minutesOf = (name: string) =>
      pub.body.staff.find((s: { displayName: string }) => s.displayName === name).prices[0]
        .durationMinutes;
    expect([minutesOf('Marek'), minutesOf('Ilia')]).toEqual([30, 60]);

    // Ilia's day ends at 18:00: his last start is 17:00, Marek's 17:30.
    const iliaTimes = (await freeTimes(`&staffId=${ilia}`)).map((s) => s.time);
    expect(iliaTimes).toContain('17:00');
    expect(iliaTimes).not.toContain('17:30');
    const all = await freeTimes('');
    const late = all.find((s) => s.time === '17:30')!;
    expect(late.staffIds).toEqual(expect.arrayContaining([marek, ola]));
    expect(late.staffIds).not.toContain(ilia);
    expect(all.find((s) => s.time === '17:00')!.staffIds).toContain(ilia);

    // A visit with Ilia lasts an hour: 10:00–11:00; 10:30 is taken, 11:00 is free.
    const withIlia = await visit(await bookOnline(at(day, 10), ilia));
    expect(withIlia.durationMinutes).toBe(60);
    expect(withIlia.endAt.getTime() - withIlia.startAt.getTime()).toBe(60 * 60_000);
    const after = (await freeTimes(`&staffId=${ilia}`)).map((s) => s.time);
    expect(after).not.toContain('10:30');
    expect(after).toContain('11:00');

    // By the salon too.
    const manual = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: ilia,
        start: at(day, 12),
        customer: { name: 'Jan Nowak', phone: '+48600000002' },
      })
      .expect(201);
    expect(manual.body.durationMinutes).toBe(60);
    const marekVisit = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: marek,
        start: at(day, 12),
        customer: { name: 'Jan Nowak', phone: '+48600000002' },
      })
      .expect(201);
    expect(marekVisit.body.durationMinutes).toBe(30);

    // Moving Ilia's visit to Marek keeps its length.
    const moved = await ctx
      .http()
      .post(`${base}/appointments/${withIlia.id}/reschedule`)
      .set(owner.auth)
      .send({ version: withIlia.version, start: at(day, 14), staffId: marek });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await visit(withIlia.id)).durationMinutes).toBe(60);

    // Back to the service's duration.
    const reset = await setDurations([]).expect(200);
    expect(reset.body.durations).toEqual([]);
    expect((await freeTimes(`&staffId=${ilia}`)).map((s) => s.time)).toContain('17:30');
  });

  it('"any of these" specialists: free times and the hold stay within the group', async () => {
    const group = await freeTimes(`&staffIds=${ola},${marek}`);
    expect(group.length).toBeGreaterThan(0);
    for (const slot of group) {
      expect(slot.staffIds.every((id) => id === ola || id === marek)).toBe(true);
    }
    // Repeated ids are fine; a bad id is a 400.
    expect((await freeTimes(`&staffIds=${ola},${ola}`))[0]!.staffIds).toEqual([ola]);
    await ctx
      .http()
      .get(
        `/v1/public/locations/${slug}/availability?serviceId=${haircutId}&from=${day}&to=${day}&staffIds=nope`,
      )
      .expect(400);

    // Ola is the only one in the group: the hold goes to her.
    const h = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId: haircutId, start: at(day, 10), staffIds: [ola] })
      .expect(201);
    expect(h.body.staffId).toBe(ola);
    // Ola is now held at 10:00; a hold for her group at the same time finds nobody.
    const again = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId: haircutId, start: at(day, 10), staffIds: [ola] });
    expect(again.status).toBe(409);
  });

  it('validation, permissions and the change log', async () => {
    expect((await setDurations([{ staffId: ilia, durationMinutes: 7 }])).status).toBe(400);
    expect((await setDurations([{ staffId: ilia, durationMinutes: 600 }])).status).toBe(400);
    await ctx
      .http()
      .put(`${base}/services/${haircutId}/staff`)
      .set(owner.auth)
      .send({ staffIds: [marek] })
      .expect(200);
    expectError(
      (await setDurations([{ staffId: ilia, durationMinutes: 45 }]).expect(400)).body,
      'VALIDATION_ERROR',
    );
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    expect((await setDurations([{ staffId: marek, durationMinutes: 45 }], kasia.auth)).status).toBe(
      403,
    );
    await setDurations([{ staffId: marek, durationMinutes: 45 }]).expect(200);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'service.staff_durations_set' } }),
    ).toBe(1);
    // Prices and durations are independent.
    await setPrices([{ staffId: marek, priceGrosze: 9000 }]).expect(200);
    const listed = await ctx.http().get(`${base}/staff-prices`).set(owner.auth).expect(200);
    expect(listed.body).toEqual({
      prices: [{ serviceId: haircutId, staffId: marek, priceGrosze: 9000 }],
      durations: [{ serviceId: haircutId, staffId: marek, durationMinutes: 45 }],
    });
  });
});
