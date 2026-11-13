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
  type TestContext,
} from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
});

/** A service and a staff member, so clients can book the salon. */
async function makeBookable(
  owner: Awaited<ReturnType<typeof signUp>>,
  salon: { orgId: string; locationId: string },
  staffLanguages: string[] = [],
): Promise<void> {
  const base = `/v1/organizations/${salon.orgId}/locations/${salon.locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
    .expect(201);
  await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [service.body.id], languages: staffLanguages })
    .expect(201);
}

describe('public salon directory', () => {
  it('filters by spoken language, paginates and exposes only public salon fields', async () => {
    const owner = await signUp(ctx, 'directory@example.com');
    const polish = await createOrgWithLocation(ctx, owner, 'Polish salon');
    const ukrainian = await createOrgWithLocation(ctx, owner, 'Ukrainian salon');
    const hidden = await createOrgWithLocation(ctx, owner, 'Private salon');
    const empty = await createOrgWithLocation(ctx, owner, 'No team yet');
    await makeBookable(owner, polish);
    await makeBookable(owner, ukrainian);
    await makeBookable(owner, hidden);

    await ctx.prisma.location.update({
      where: { id: polish.locationId },
      data: {
        onlineBookingEnabled: true,
        ...LEGAL_TEXTS,
        languages: ['pl', 'en'],
        latitude: 52.2,
        longitude: 21.0,
      },
    });
    await ctx.prisma.location.update({
      where: { id: ukrainian.locationId },
      data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, languages: ['uk', 'be'] },
    });
    await ctx.prisma.location.update({
      where: { id: hidden.locationId },
      data: { onlineBookingEnabled: false, languages: ['pl'] },
    });
    // Online booking is on, but there is nothing to book yet: not in the catalogue.
    await ctx.prisma.location.update({
      where: { id: empty.locationId },
      data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, languages: ['pl'] },
    });

    const all = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ page: 1, pageSize: 1 })
      .expect(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 1, total: 2, pageCount: 2 });
    expect(all.body.items).toHaveLength(1);
    expect(all.body.items[0]).not.toHaveProperty('organizationId');
    expect(all.body.items[0]).not.toHaveProperty('phone');
    expect(all.body.items[0]).not.toHaveProperty('email');
    const shape = registeredResponseSchema('PublicSalonDirectory').safeParse(all.body);
    expect(shape.error?.issues ?? []).toEqual([]);

    const belarusian = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ language: 'be', page: 1, pageSize: 12 })
      .expect(200);
    expect(belarusian.body.total).toBe(1);
    expect(belarusian.body.items[0]).toMatchObject({
      slug: ukrainian.slug,
      languages: ['uk', 'be'],
      latitude: null,
      longitude: null,
    });

    const secondPage = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ page: 2, pageSize: 1 })
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.items[0]).toMatchObject({
      slug: ukrainian.slug,
      latitude: null,
      longitude: null,
    });
  });

  it('finds a salon by the language of one of its staff members', async () => {
    const owner = await signUp(ctx, 'staff-languages@example.com');
    const salon = await createOrgWithLocation(ctx, owner, 'Mixed team');
    await makeBookable(owner, salon, ['en', 'pl']);
    await ctx.prisma.location.update({
      where: { id: salon.locationId },
      data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, languages: ['pl'] },
    });

    const english = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ language: 'en' })
      .expect(200);
    expect(english.body.items.map((s: { slug: string }) => s.slug)).toEqual([salon.slug]);
    // Languages of the salon and its team, in the usual order.
    expect(english.body.items[0].languages).toEqual(['pl', 'en']);
    const russian = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ language: 'ru' })
      .expect(200);
    expect(russian.body.total).toBe(0);

    // A staff member who left no longer counts.
    await ctx.prisma.staffMember.updateMany({
      where: { locationId: salon.locationId },
      data: { active: false },
    });
    const none = await ctx.http().get('/v1/public/locations').query({ language: 'en' }).expect(200);
    expect(none.body).toMatchObject({ items: [], page: 1, pageSize: 12, total: 0, pageCount: 0 });
    // Nobody active is left: the salon is not bookable, so it counts nowhere.
    expect(none.body.languageCounts).toEqual({ pl: 0, uk: 0, ru: 0, be: 0, en: 0 });
  });

  it('counts salons per language and kind of place, and specialists speaking the language (task 160)', async () => {
    const owner = await signUp(ctx, 'map-chips@example.com');
    const barber = await createOrgWithLocation(ctx, owner, 'Barber UA');
    const nails = await createOrgWithLocation(ctx, owner, 'Nails PL');
    await makeBookable(owner, barber, ['uk', 'pl']);
    await makeBookable(owner, nails, ['pl']);
    // A second Ukrainian-speaking barber, and the kinds of place.
    const base = `/v1/organizations/${barber.orgId}/locations/${barber.locationId}`;
    const serviceId = (
      await ctx.prisma.service.findFirstOrThrow({ where: { locationId: barber.locationId } })
    ).id;
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Taras', serviceIds: [serviceId], languages: ['uk'] })
      .expect(201);
    await ctx.prisma.staffMember.updateMany({
      where: { locationId: barber.locationId },
      data: { specialties: ['barber'] },
    });
    await ctx.prisma.staffMember.updateMany({
      where: { locationId: nails.locationId },
      data: { specialties: ['nails'] },
    });
    for (const salon of [barber, nails]) {
      await ctx.prisma.location.update({
        where: { id: salon.locationId },
        data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, languages: ['pl'] },
      });
    }
    const photo = await ctx.prisma.photo.create({
      data: {
        locationId: nails.locationId,
        contentType: 'image/jpeg',
        sizeBytes: 3,
        data: Buffer.from([1, 2, 3]),
      },
    });

    const all = await ctx.http().get('/v1/public/locations').expect(200);
    expect(
      registeredResponseSchema('PublicSalonDirectory').safeParse(all.body).error?.issues ?? [],
    ).toEqual([]);
    expect(all.body.languageCounts).toEqual({ pl: 2, uk: 1, ru: 0, be: 0, en: 0 });
    expect(all.body.specialtyCounts).toMatchObject({ barber: 1, nails: 1, hairdresser: 0 });
    const bySlug = (body: { items: { slug: string }[] }, slug: string) =>
      body.items.find((s) => s.slug === slug) as Record<string, unknown>;
    expect(bySlug(all.body, barber.slug)).toMatchObject({
      staffSpeaking: null,
      specialties: ['barber'],
      photoUrl: null,
    });
    expect(bySlug(all.body, nails.slug)).toMatchObject({
      specialties: ['nails'],
      photoUrl: `/v1/public/photos/${photo.id}`,
    });

    // Ukrainian: only the barber, two of its specialists speak it.
    const ukrainian = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ language: 'uk' })
      .expect(200);
    expect(ukrainian.body.items).toHaveLength(1);
    expect(bySlug(ukrainian.body, barber.slug)).toMatchObject({ staffSpeaking: 2 });
    expect(ukrainian.body.specialtyCounts).toMatchObject({ barber: 1, nails: 0 });

    // Nails: the language chips count only nail salons.
    const nailSalons = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ specialty: 'nails' })
      .expect(200);
    expect(nailSalons.body.items.map((s: { slug: string }) => s.slug)).toEqual([nails.slug]);
    expect(nailSalons.body.languageCounts).toEqual({ pl: 1, uk: 0, ru: 0, be: 0, en: 0 });
    await ctx.http().get('/v1/public/locations').query({ specialty: 'tattoo' }).expect(400);
  });

  it('several languages at once find salons speaking any of them (task 192)', async () => {
    const owner = await signUp(ctx, 'languages-or@example.com');
    const ua = await createOrgWithLocation(ctx, owner, 'Barber UA');
    const ru = await createOrgWithLocation(ctx, owner, 'Barber RU');
    const en = await createOrgWithLocation(ctx, owner, 'Barber EN');
    await makeBookable(owner, ua, ['uk']);
    await makeBookable(owner, ru, ['ru', 'uk']);
    await makeBookable(owner, en, ['en']);
    for (const salon of [ua, ru, en]) {
      await ctx.prisma.location.update({
        where: { id: salon.locationId },
        data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, languages: ['pl'] },
      });
    }
    const slugs = (body: { items: { slug: string }[] }) => body.items.map((s) => s.slug).sort();

    const either = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ language: 'ru,be,ru' })
      .expect(200);
    expect(slugs(either.body)).toEqual([ru.slug]);
    const eastern = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ language: 'uk,ru,be' })
      .expect(200);
    expect(slugs(eastern.body)).toEqual([ua.slug, ru.slug].sort());
    expect(eastern.body.total).toBe(2);
    // Each chip still counts its own language.
    expect(eastern.body.languageCounts).toEqual({ pl: 3, uk: 2, ru: 1, be: 0, en: 1 });
    // A specialist counts once, whichever of the languages they speak.
    const bySlug = (slug: string) =>
      eastern.body.items.find((s: { slug: string }) => s.slug === slug);
    expect(bySlug(ru.slug).staffSpeaking).toBe(1);
    expect(bySlug(ua.slug).staffSpeaking).toBe(1);

    await ctx.http().get('/v1/public/locations').query({ language: 'uk,fr' }).expect(400);
  });

  it('finds salons by words in the name, city, street or a service, with or without Polish letters (task 180b)', async () => {
    const owner = await signUp(ctx, 'search@example.com');
    const torun = await createOrgWithLocation(ctx, owner, 'Fryzjer Żaneta');
    const gdansk = await createOrgWithLocation(ctx, owner, 'Barber Gdańsk');
    await makeBookable(owner, torun);
    await makeBookable(owner, gdansk);
    await ctx.prisma.location.update({
      where: { id: torun.locationId },
      data: {
        onlineBookingEnabled: true,
        ...LEGAL_TEXTS,
        city: 'Toruń',
        addressLine: 'ul. Łąkowa 5',
      },
    });
    await ctx.prisma.location.update({
      where: { id: gdansk.locationId },
      data: {
        onlineBookingEnabled: true,
        ...LEGAL_TEXTS,
        city: 'Gdańsk',
        addressLine: 'ul. Długa 1',
      },
    });
    await ctx.prisma.service.updateMany({
      where: { locationId: gdansk.locationId },
      data: { name: 'Golenie brzytwą' },
    });
    const find = async (q: string) =>
      (await ctx.http().get('/v1/public/locations').query({ q }).expect(200)).body.items.map(
        (s: { slug: string }) => s.slug,
      );

    expect(await find('torun')).toEqual([torun.slug]);
    expect(await find('ŁĄKOWA')).toEqual([torun.slug]);
    expect(await find('lakowa 5 zaneta')).toEqual([torun.slug]);
    expect(await find('brzytwa')).toEqual([gdansk.slug]);
    // Both do haircuts ("Strzyżenie" at Toruń only now) - every word must match.
    expect(await find('strzyzenie')).toEqual([torun.slug]);
    expect(await find('barber torun')).toEqual([]);
    expect(await find('%')).toEqual([]);
    // The language chips count only what was found.
    await ctx.prisma.location.updateMany({ data: { languages: ['pl'] } });
    const res = await ctx.http().get('/v1/public/locations').query({ q: 'gdansk' }).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.languageCounts.pl).toBe(1);
    await ctx
      .http()
      .get('/v1/public/locations')
      .query({ q: 'x'.repeat(101) })
      .expect(400);
  });

  it('lists the nearest salons first with the distance, and the stars of salons collecting reviews (task 180b)', async () => {
    const owner = await signUp(ctx, 'near@example.com');
    const krakow = await createOrgWithLocation(ctx, owner, 'Krakow salon');
    const center = await createOrgWithLocation(ctx, owner, 'Center salon');
    const praga = await createOrgWithLocation(ctx, owner, 'Praga salon');
    const nowhere = await createOrgWithLocation(ctx, owner, 'Somewhere salon');
    for (const salon of [krakow, center, praga, nowhere]) await makeBookable(owner, salon);
    const place = async (
      salon: { locationId: string },
      latitude: number | null,
      longitude: number | null,
    ) =>
      ctx.prisma.location.update({
        where: { id: salon.locationId },
        data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, latitude, longitude },
      });
    await place(krakow, 50.0614, 19.9366);
    await place(center, 52.2297, 21.0122);
    await place(praga, 52.2508, 21.0353);
    await place(nowhere, null, null);

    // Reviews: two for the center salon, which collects them; one for Praga, which does not.
    const review = async (
      salon: { orgId: string; locationId: string },
      rating: number,
      at: number,
    ) => {
      const staff = await ctx.prisma.staffMember.findFirstOrThrow({
        where: { locationId: salon.locationId },
      });
      const service = await ctx.prisma.service.findFirstOrThrow({
        where: { locationId: salon.locationId },
      });
      const customer = await ctx.prisma.customer.create({
        data: { organizationId: salon.orgId, name: `Client ${at}`, phone: `+4850000000${at}` },
      });
      const startAt = new Date(Date.now() - (at + 1) * 86_400_000);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);
      const visit = await ctx.prisma.appointment.create({
        data: {
          locationId: salon.locationId,
          staffId: staff.id,
          serviceId: service.id,
          customerId: customer.id,
          status: 'completed',
          source: 'online',
          startAt,
          endAt,
          blockedUntil: endAt,
          priceGrosze: 8000,
          durationMinutes: 30,
          bufferMinutes: 0,
        },
      });
      await ctx.prisma.visitReview.create({
        data: { appointmentId: visit.id, locationId: salon.locationId, staffId: staff.id, rating },
      });
    };
    await ctx.prisma.reviewSettings.create({
      data: { locationId: center.locationId, enabled: true },
    });
    await review(center, 5, 1);
    await review(center, 4, 2);
    await review(praga, 1, 3);

    const near = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ near: '52.2297,21.0122', pageSize: 2 })
      .expect(200);
    expect(near.body.total).toBe(4);
    expect(near.body.items.map((s: { slug: string }) => s.slug)).toEqual([center.slug, praga.slug]);
    expect(near.body.items[0]).toMatchObject({ distanceKm: 0, rating: 4.5, reviewCount: 2 });
    expect(near.body.items[1].distanceKm).toBeCloseTo(3, 0);
    // Praga does not collect reviews: no stars, even with a review stored.
    expect(near.body.items[1]).toMatchObject({ rating: null, reviewCount: 0 });
    const shape = registeredResponseSchema('PublicSalonDirectory').safeParse(near.body);
    expect(shape.error?.issues ?? []).toEqual([]);

    const second = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ near: '52.2297,21.0122', pageSize: 2, page: 2 })
      .expect(200);
    expect(
      second.body.items.map((s: { slug: string; distanceKm: number | null }) => [
        s.slug,
        s.distanceKm !== null,
      ]),
    ).toEqual([
      [krakow.slug, true],
      [nowhere.slug, false],
    ]);
    expect(second.body.items[0].distanceKm).toBeGreaterThan(200);

    // Without `near`: the usual order (city, name) and no distance.
    const plainList = await ctx.http().get('/v1/public/locations').expect(200);
    expect(plainList.body.items.every((s: { distanceKm: unknown }) => s.distanceKm === null)).toBe(
      true,
    );

    for (const bad of ['52.2', 'abc,def', '91,0', '0,181', '52.2,21.0,1']) {
      await ctx.http().get('/v1/public/locations').query({ near: bad }).expect(400);
    }
  });

  it('"Najlepiej oceniane" puts the best stars first, then more reviews, salons without stars last (task 378)', async () => {
    const owner = await signUp(ctx, 'rated@example.com');
    const alpha = await createOrgWithLocation(ctx, owner, 'Alpha salon');
    const beta = await createOrgWithLocation(ctx, owner, 'Beta salon');
    const gamma = await createOrgWithLocation(ctx, owner, 'Gamma salon');
    const delta = await createOrgWithLocation(ctx, owner, 'Delta salon');
    const hidden = await createOrgWithLocation(ctx, owner, 'Hidden salon');
    for (const salon of [alpha, beta, gamma, delta, hidden]) {
      await makeBookable(owner, salon);
      await ctx.prisma.location.update({
        where: { id: salon.locationId },
        data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, latitude: 52.2297, longitude: 21.0122 },
      });
    }
    let n = 0;
    const review = async (salon: { orgId: string; locationId: string }, rating: number) => {
      n += 1;
      const staff = await ctx.prisma.staffMember.findFirstOrThrow({
        where: { locationId: salon.locationId },
      });
      const service = await ctx.prisma.service.findFirstOrThrow({
        where: { locationId: salon.locationId },
      });
      const customer = await ctx.prisma.customer.create({
        data: { organizationId: salon.orgId, name: `Client ${n}`, phone: `+4851100${1000 + n}` },
      });
      const startAt = new Date(Date.now() - (n + 1) * 86_400_000);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);
      const visit = await ctx.prisma.appointment.create({
        data: {
          locationId: salon.locationId,
          staffId: staff.id,
          serviceId: service.id,
          customerId: customer.id,
          status: 'completed',
          source: 'online',
          startAt,
          endAt,
          blockedUntil: endAt,
          priceGrosze: 8000,
          durationMinutes: 30,
          bufferMinutes: 0,
        },
      });
      await ctx.prisma.visitReview.create({
        data: { appointmentId: visit.id, locationId: salon.locationId, staffId: staff.id, rating },
      });
    };
    // Gamma 5.0 (1 review), Delta 4.5 (4), Beta 4.5 (2), Alpha none; Hidden has 5 stars stored
    // but does not collect reviews — no stars, so it is not "best rated".
    for (const salon of [beta, gamma, delta]) {
      await ctx.prisma.reviewSettings.create({
        data: { locationId: salon.locationId, enabled: true },
      });
    }
    await review(gamma, 5);
    await review(delta, 5);
    await review(delta, 4);
    await review(delta, 5);
    await review(delta, 4);
    await review(beta, 5);
    await review(beta, 4);
    await review(hidden, 5);

    const slugs = (body: { items: { slug: string }[] }) => body.items.map((s) => s.slug);
    const first = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ sort: 'rating', pageSize: 3 })
      .expect(200);
    expect(first.body.total).toBe(5);
    expect(slugs(first.body)).toEqual([gamma.slug, delta.slug, beta.slug]);
    expect(first.body.items[1]).toMatchObject({ rating: 4.5, reviewCount: 4, distanceKm: null });
    const shape = registeredResponseSchema('PublicSalonDirectory').safeParse(first.body);
    expect(shape.error?.issues ?? []).toEqual([]);

    // Then the salons without stars, in the usual order (city, name).
    const second = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ sort: 'rating', pageSize: 3, page: 2 })
      .expect(200);
    expect(slugs(second.body)).toEqual([alpha.slug, hidden.slug]);
    expect(second.body.items[1]).toMatchObject({ rating: null, reviewCount: 0 });

    // With "W pobliżu" too: the stars decide the order, the distance is still shown.
    const near = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ sort: 'rating', near: '52.2297,21.0122', pageSize: 2 })
      .expect(200);
    expect(slugs(near.body)).toEqual([gamma.slug, delta.slug]);
    expect(near.body.items[0].distanceKm).toBe(0);

    // Other filters still apply.
    const searched = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ sort: 'rating', q: 'beta' })
      .expect(200);
    expect(slugs(searched.body)).toEqual([beta.slug]);

    await ctx.http().get('/v1/public/locations').query({ sort: 'price' }).expect(400);
  });

  it("shows the lowest price a client can book, counting specialists' own prices (task 91)", async () => {
    const owner = await signUp(ctx, 'price-from@example.com');
    const salon = await createOrgWithLocation(ctx, owner, 'Price from');
    await makeBookable(owner, salon); // Strzyżenie 80 zł with Kasia
    await ctx.prisma.location.update({
      where: { id: salon.locationId },
      data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, currency: 'EUR' },
    });
    const base = `/v1/organizations/${salon.orgId}/locations/${salon.locationId}`;
    const add = async (name: string, priceGrosze: number) =>
      (
        await ctx
          .http()
          .post(`${base}/services`)
          .set(owner.auth)
          .send({ name, durationMinutes: 30, priceGrosze })
          .expect(201)
      ).body.id as string;
    const beard = await add('Broda', 6000);
    const consult = await add('Konsultacja', 0);
    const hidden = await add('Stara usługa', 1000);
    const nobody = await add('Nikt nie robi', 2000);

    const staff = async (displayName: string, serviceIds: string[]) =>
      (
        await ctx
          .http()
          .post(`${base}/staff`)
          .set(owner.auth)
          .send({ displayName, serviceIds })
          .expect(201)
      ).body.id as string;
    const tomek = await staff('Tomek', [beard, consult, hidden]);
    const left = await staff('Ola', [beard]);
    expect(nobody).toBeTruthy();
    await ctx.prisma.service.update({ where: { id: hidden }, data: { active: false } });

    const fetchSalon = async () => {
      const response = await ctx.http().get('/v1/public/locations').expect(200);
      expect(
        registeredResponseSchema('PublicSalonDirectory').safeParse(response.body).success,
      ).toBe(true);
      return response.body.items.find((s: { slug: string }) => s.slug === salon.slug);
    };

    // Free and hidden services and services nobody performs do not count.
    expect(await fetchSalon()).toMatchObject({ currency: 'EUR', priceFromGrosze: 6000 });

    // A specialist's own price counts; one of a specialist who left does not.
    await ctx.prisma.staffService.update({
      where: { staffId_serviceId: { staffId: tomek, serviceId: beard } },
      data: { priceGrosze: 4500 },
    });
    await ctx.prisma.staffService.update({
      where: { staffId_serviceId: { staffId: left, serviceId: beard } },
      data: { priceGrosze: 3000 },
    });
    await ctx.prisma.staffMember.update({ where: { id: left }, data: { active: false } });
    expect((await fetchSalon()).priceFromGrosze).toBe(4500);

    // Only free services left: no price to show.
    await ctx.prisma.service.updateMany({
      where: { id: { not: consult }, locationId: salon.locationId },
      data: { active: false },
    });
    expect((await fetchSalon()).priceFromGrosze).toBeNull();
  });

  it('shows today’s real hours of each salon on its card (task 363)', async () => {
    const owner = await signUp(ctx, 'today@example.com');
    const every = (start: string, end: string) =>
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ start, end }] }));
    const salon = async (name: string) => {
      const s = await createOrgWithLocation(ctx, owner, name);
      const base = `/v1/organizations/${s.orgId}/locations/${s.locationId}`;
      const service = await ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
        .expect(201);
      const staff = async (
        displayName: string,
        serviceIds: string[],
        start: string,
        end: string,
      ) => {
        const id = (
          await ctx
            .http()
            .post(`${base}/staff`)
            .set(owner.auth)
            .send({ displayName, serviceIds })
            .expect(201)
        ).body.id as string;
        await ctx
          .http()
          .put(`${base}/staff/${id}/working-hours`)
          .set(owner.auth)
          .send({ days: every(start, end) })
          .expect(200);
        return id;
      };
      const kasia = await staff('Kasia', [service.body.id], '09:00', '17:00');
      // Takes no bookings (no services): her hours are not the salon's.
      await staff('Recepcja', [], '00:00', '24:00');
      await ctx.prisma.location.update({
        where: { id: s.locationId },
        data: { onlineBookingEnabled: true, ...LEGAL_TEXTS },
      });
      return { ...s, kasia };
    };
    const open = await salon('Open today');
    const away = await salon('On vacation');
    const today = localToday(Date.now(), 'Europe/Warsaw');
    await ctx.prisma.timeOff.create({
      data: {
        staffId: away.kasia,
        startsAt: new Date(zonedToInstant(today, 0, 'Europe/Warsaw')),
        endsAt: new Date(zonedToInstant(addDays(today, 2), 0, 'Europe/Warsaw')),
      },
    });

    const res = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ page: 1, pageSize: 12 })
      .expect(200);
    const card = (slug: string) =>
      res.body.items.find((i: { slug: string }) => i.slug === slug) as {
        timezone: string;
        todayHours: unknown;
      };
    expect(card(open.slug)).toMatchObject({
      timezone: 'Europe/Warsaw',
      todayHours: [{ start: '09:00', end: '17:00' }],
    });
    expect(card(away.slug).todayHours).toEqual([]);
    const shape = registeredResponseSchema('PublicSalonDirectory').safeParse(res.body);
    expect(shape.error?.issues ?? []).toEqual([]);
  });

  it('"Otwarte teraz" shows only salons open right now, with the number on the chip (task 365)', async () => {
    const owner = await signUp(ctx, 'open-now@example.com');
    const salon = async (name: string, hours: boolean, languages: string[] = []) => {
      const s = await createOrgWithLocation(ctx, owner, name);
      const base = `/v1/organizations/${s.orgId}/locations/${s.locationId}`;
      const service = await ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
        .expect(201);
      const staff = async (displayName: string, serviceIds: string[], withHours: boolean) => {
        const id = (
          await ctx
            .http()
            .post(`${base}/staff`)
            .set(owner.auth)
            .send({ displayName, serviceIds, languages })
            .expect(201)
        ).body.id as string;
        if (withHours) {
          await ctx
            .http()
            .put(`${base}/staff/${id}/working-hours`)
            .set(owner.auth)
            .send({
              days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
                weekday,
                intervals: [{ start: '00:00', end: '24:00' }],
              })),
            })
            .expect(200);
        }
        return id;
      };
      const kasia = await staff('Kasia', [service.body.id], hours);
      // Takes no bookings: her round-the-clock hours do not open the salon.
      await staff('Recepcja', [], true);
      await ctx.prisma.location.update({
        where: { id: s.locationId },
        data: { onlineBookingEnabled: true, ...LEGAL_TEXTS },
      });
      return { ...s, kasia };
    };
    const open = await salon('Round the clock', true, ['uk']);
    const openPolish = await salon('Round the clock too', true);
    const away = await salon('On vacation', true, ['uk']);
    const blocked = await salon('Closed for a training', true);
    const noHours = await salon('No hours yet', false);
    const today = localToday(Date.now(), 'Europe/Warsaw');
    await ctx.prisma.timeOff.create({
      data: {
        staffId: away.kasia,
        startsAt: new Date(zonedToInstant(today, 0, 'Europe/Warsaw')),
        endsAt: new Date(zonedToInstant(addDays(today, 2), 0, 'Europe/Warsaw')),
      },
    });
    await ctx.prisma.timeBlock.create({
      data: {
        locationId: blocked.locationId,
        startAt: new Date(Date.now() - 3_600_000),
        endAt: new Date(Date.now() + 3_600_000),
        reason: 'Szkolenie',
      },
    });

    const list = async (query: Record<string, string | number>) =>
      (await ctx.http().get('/v1/public/locations').query(query).expect(200)).body as {
        items: { slug: string }[];
        total: number;
        openNowCount: number;
        languageCounts: Record<string, number>;
      };
    const all = await list({ page: 1, pageSize: 12 });
    expect(all.total).toBe(5);
    expect(all.openNowCount).toBe(2);

    const now = await list({ openNow: 'true' });
    expect(now.items.map((i) => i.slug).sort()).toEqual([open.slug, openPolish.slug].sort());
    expect(now.total).toBe(2);
    expect(now.openNowCount).toBe(2);
    // The language chips count the open salons only.
    expect(now.languageCounts.uk).toBe(1);
    expect(all.languageCounts.uk).toBe(2);
    for (const closed of [away, blocked, noHours]) {
      expect(now.items.some((i) => i.slug === closed.slug)).toBe(false);
    }

    // With the other filters: a language, the search.
    const ukrainian = await list({ openNow: 'true', language: 'uk' });
    expect(ukrainian.items.map((i) => i.slug)).toEqual([open.slug]);
    expect((await list({ language: 'uk' })).openNowCount).toBe(1);
    const searched = await list({ openNow: 'true', q: 'too' });
    expect(searched.items.map((i) => i.slug)).toEqual([openPolish.slug]);
    expect((await list({ q: 'vacation' })).openNowCount).toBe(0);
    expect((await list({ openNow: 'false' })).total).toBe(5);
    await ctx.http().get('/v1/public/locations').query({ openNow: 'yes' }).expect(400);

    const shape = registeredResponseSchema('PublicSalonDirectory').safeParse(now);
    expect(shape.error?.issues ?? []).toEqual([]);
  });

  it('"Inne salony w pobliżu" lists the salons nearest to a salon, without it (task 400)', async () => {
    const owner = await signUp(ctx, 'neighbours@example.com');
    const center = await createOrgWithLocation(ctx, owner, 'Center salon');
    const praga = await createOrgWithLocation(ctx, owner, 'Praga salon');
    const mokotow = await createOrgWithLocation(ctx, owner, 'Mokotow salon');
    const krakow = await createOrgWithLocation(ctx, owner, 'Krakow salon');
    const nowhere = await createOrgWithLocation(ctx, owner, 'Somewhere salon');
    const closed = await createOrgWithLocation(ctx, owner, 'Closed salon');
    for (const salon of [center, praga, mokotow, krakow, nowhere, closed]) {
      await makeBookable(owner, salon);
    }
    const place = async (
      salon: { locationId: string },
      latitude: number | null,
      longitude: number | null,
      onlineBookingEnabled = true,
    ) =>
      ctx.prisma.location.update({
        where: { id: salon.locationId },
        data: { onlineBookingEnabled, ...LEGAL_TEXTS, latitude, longitude },
      });
    await place(center, 52.2297, 21.0122);
    await place(praga, 52.2508, 21.0353);
    await place(mokotow, 52.1934, 21.0346);
    await place(krakow, 50.0614, 19.9366);
    await place(nowhere, null, null);
    // Not in the catalogue: never a neighbour, and has no neighbours itself.
    await place(closed, 52.23, 21.013, false);

    const res = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ nearSalon: center.slug, pageSize: 3 })
      .expect(200);
    expect(res.body.total).toBe(4);
    expect(res.body.items.map((s: { slug: string; distanceKm: number | null }) => s.slug)).toEqual([
      praga.slug,
      mokotow.slug,
      krakow.slug,
    ]);
    expect(res.body.items[0].distanceKm).toBeCloseTo(2.9, 0);
    expect(res.body.items[1].distanceKm).toBeCloseTo(4.4, 0);
    expect(res.body.items[2].distanceKm).toBeGreaterThan(250);
    const shape = registeredResponseSchema('PublicSalonDirectory').safeParse(res.body);
    expect(shape.error?.issues ?? []).toEqual([]);

    // The other filters still apply (here: a search that finds only Krakow and the salon itself).
    const krakowOnly = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ nearSalon: center.slug, q: 'krakow' })
      .expect(200);
    expect(krakowOnly.body.items.map((s: { slug: string }) => s.slug)).toEqual([krakow.slug]);

    // No place on the map, a salon outside the catalogue or an unknown slug: nothing.
    for (const slug of [nowhere.slug, closed.slug, 'no-such-salon']) {
      const none = await ctx
        .http()
        .get('/v1/public/locations')
        .query({ nearSalon: slug })
        .expect(200);
      expect(none.body).toMatchObject({ items: [], total: 0, pageCount: 0, openNowCount: 0 });
    }
  });

  it('rejects unsupported language filters and out-of-range pagination', async () => {
    await ctx.http().get('/v1/public/locations').query({ language: 'fr' }).expect(400);
    await ctx.http().get('/v1/public/locations').query({ page: 0 }).expect(400);
    await ctx.http().get('/v1/public/locations').query({ pageSize: 51 }).expect(400);
  });

  it('requires salon coordinates to be set and cleared as a pair', async () => {
    const owner = await signUp(ctx, 'coordinate-owner@example.com');
    const { orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Coordinate salon');
    const response = await ctx
      .http()
      .patch(`/v1/organizations/${orgId}/locations/${locationId}`)
      .set(owner.auth)
      .send({ version: 1, latitude: 52.2 })
      .expect(400);
    expectError(response.body, 'VALIDATION_ERROR');
  });
});
