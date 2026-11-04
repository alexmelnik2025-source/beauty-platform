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
 * Task 70, part a: a specialist's own price and duration of a service. Ilya and Nazar cut for
 * 162 zł in 80 minutes, Kasia for the service's 150 zł in 60. "Any of these" (one price row
 * on the booking page) gives a free specialist of that row only.
 */

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let kasiaUser: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let haircutId: string;
let ilyaId: string;
let nazarId: string;
let kasiaId: string;
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

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
      .send({ name: 'Strzyżenie', durationMinutes: 60, bufferMinutes: 0, priceGrosze: 15000 })
      .expect(201)
  ).body.id;
  const ids: string[] = [];
  for (const name of ['Ilya', 'Nazar', 'Kasia']) {
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
  [ilyaId, nazarId, kasiaId] = ids as [string, string, string];
  kasiaUser = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: kasiaUser.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

const setOffers = (offers: object[], auth = owner.auth) =>
  ctx.http().put(`${base}/services/${haircutId}/staff-offers`).set(auth).send({ offers });

const ilyaAndNazar = () =>
  setOffers([
    { staffId: ilyaId, priceGrosze: 16200, durationMinutes: 80 },
    { staffId: nazarId, priceGrosze: 16200, durationMinutes: 80 },
  ]).expect(200);

const hold = (body: object) =>
  ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId: haircutId, ...body });

const availability = (query: string) =>
  ctx
    .http()
    .get(
      `/v1/public/locations/${slug}/availability?serviceId=${haircutId}&from=${day}&to=${day}${query}`,
    )
    .expect(200);

describe('a specialist’s own price and duration', () => {
  it('the owner sets them; the service and the public page show them', async () => {
    const saved = await ilyaAndNazar();
    expect(registeredResponseSchema('Service').safeParse(saved.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(saved.body.staffOffers).toEqual(
      [
        { staffId: ilyaId, priceGrosze: 16200, durationMinutes: 80 },
        { staffId: nazarId, priceGrosze: 16200, durationMinutes: 80 },
      ].sort((a, b) => a.staffId.localeCompare(b.staffId)),
    );

    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(
      registeredResponseSchema('PublicLocation').safeParse(page.body).error?.issues ?? [],
    ).toEqual([]);
    const haircut = page.body.services.find((s: { id: string }) => s.id === haircutId);
    expect(haircut).toMatchObject({ priceGrosze: 15000, durationMinutes: 60 });
    expect(haircut.staffOffers).toEqual([
      { staffId: ilyaId, priceGrosze: 16200, durationMinutes: 80 },
      { staffId: nazarId, priceGrosze: 16200, durationMinutes: 80 },
      { staffId: kasiaId, priceGrosze: 15000, durationMinutes: 60 },
    ]);

    // Changing who performs the service keeps the prices of those who stay.
    await ctx
      .http()
      .put(`${base}/services/${haircutId}/staff`)
      .set(owner.auth)
      .send({ staffIds: [ilyaId, kasiaId] })
      .expect(200);
    await ctx
      .http()
      .put(`${base}/staff/${ilyaId}/services`)
      .set(owner.auth)
      .send({ serviceIds: [haircutId] })
      .expect(200);
    const after = await ctx.http().get(`${base}/services/${haircutId}`).set(owner.auth);
    expect(after.body.staffOffers).toEqual([
      { staffId: ilyaId, priceGrosze: 16200, durationMinutes: 80 },
    ]);

    // null = as the service says again.
    const reset = await setOffers([
      { staffId: ilyaId, priceGrosze: null, durationMinutes: null },
    ]).expect(200);
    expect(reset.body.staffOffers).toEqual([]);
  });

  it('only owners and managers; only for specialists who perform the service', async () => {
    expectError(
      (
        await setOffers(
          [{ staffId: kasiaId, priceGrosze: 1, durationMinutes: null }],
          kasiaUser.auth,
        ).expect(403)
      ).body,
      'FORBIDDEN',
    );
    await ctx
      .http()
      .put(`${base}/services/${haircutId}/staff`)
      .set(owner.auth)
      .send({ staffIds: [ilyaId] })
      .expect(200);
    expectError(
      (await setOffers([{ staffId: kasiaId, priceGrosze: 1, durationMinutes: null }]).expect(400))
        .body,
      'STAFF_SERVICE_MISMATCH',
    );
    // Nothing was saved for anybody when one entry is refused.
    await setOffers([
      { staffId: ilyaId, priceGrosze: 100, durationMinutes: null },
      { staffId: kasiaId, priceGrosze: 1, durationMinutes: null },
    ]).expect(400);
    const service = await ctx.http().get(`${base}/services/${haircutId}`).set(owner.auth);
    expect(service.body.staffOffers).toEqual([]);
    await setOffers([{ staffId: ilyaId, priceGrosze: 100, durationMinutes: 7 }]).expect(400);
  });

  it('free times follow each specialist’s duration; "any of these" keeps to the row', async () => {
    await ilyaAndNazar();
    const all = await availability('');
    const slot = (time: string) =>
      all.body.slots.find((s: { time: string }) => s.time === time)?.staffIds ?? [];
    // 80 minutes end by 18:00 only up to 16:40; Kasia's 60 minutes up to 17:00.
    expect(slot('16:40')).toEqual([ilyaId, nazarId, kasiaId]);
    expect(slot('17:00')).toEqual([kasiaId]);

    const row = await availability(`&staffIds=${ilyaId},${nazarId}`);
    expect(row.body.slots.some((s: { time: string }) => s.time === '17:00')).toBe(false);
    for (const s of row.body.slots) expect(s.staffIds).not.toContain(kasiaId);
  });

  it('a hold gets the price and duration of the specialist; "any of these" only from the row', async () => {
    await ilyaAndNazar();
    // Ilya is chosen by name.
    const ilya = await hold({ staffId: ilyaId, start: at(day, 10) }).expect(201);
    expect(ilya.body).toMatchObject({ staffId: ilyaId, priceGrosze: 16200 });
    expect(Date.parse(ilya.body.end) - Date.parse(ilya.body.start)).toBe(80 * 60_000);
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: ilya.body.holdId } });
    expect(row).toMatchObject({
      durationMinutes: 80,
      priceGrosze: 16200,
      staffChosenByClient: true,
    });

    // "Dowolny" in the 162 zł row: Ilya is busy at 10:00, so Nazar — never Kasia (150 zł).
    const any = await hold({ staffIds: [ilyaId, nazarId], start: at(day, 10) }).expect(201);
    expect(any.body).toMatchObject({ staffId: nazarId, priceGrosze: 16200 });
    // Both of the row are busy now: the time is taken, though Kasia is free.
    expectError(
      (await hold({ staffIds: [ilyaId, nazarId], start: at(day, 10) }).expect(409)).body,
      'SLOT_TAKEN',
    );
    // Plain "any specialist" still finds Kasia, at her own price and duration.
    const kasia = await hold({ start: at(day, 10) }).expect(201);
    expect(kasia.body).toMatchObject({ staffId: kasiaId, priceGrosze: 15000 });
    expect(Date.parse(kasia.body.end) - Date.parse(kasia.body.start)).toBe(60 * 60_000);
  });

  it('a visit added by the salon takes the specialist’s price and duration', async () => {
    await ilyaAndNazar();
    const visit = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId: nazarId,
        start: at(day, 12),
        customer: { name: 'Jan Nowak', phone: '+48600000002' },
      })
      .expect(201);
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: visit.body.id } });
    expect(row).toMatchObject({ priceGrosze: 16200, durationMinutes: 80 });
    expect(row.endAt.getTime() - row.startAt.getTime()).toBe(80 * 60_000);
  });
});
