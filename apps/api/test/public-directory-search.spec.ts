import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { distanceKm, fold, matchesSearch } from '../src/scheduling/public-directory.controller';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type TestContext,
} from './helpers';

/**
 * Task 180b: the client's home page searches the catalogue - "Czego szukasz?" (a service or the
 * salon's name), "Gdzie?" (a city) and "W pobliżu" (nearest first).
 */

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

type Owner = Awaited<ReturnType<typeof signUp>>;

/** A bookable salon in `city` with the services named, optionally on the map. */
async function salonWith(
  owner: Owner,
  name: string,
  city: string,
  services: string[],
  place?: { latitude: number; longitude: number },
): Promise<string> {
  const salon = await createOrgWithLocation(ctx, owner, name);
  const base = `/v1/organizations/${salon.orgId}/locations/${salon.locationId}`;
  const ids: string[] = [];
  for (const service of services) {
    const created = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: service, durationMinutes: 30, priceGrosze: 5000 })
      .expect(201);
    ids.push(created.body.id as string);
  }
  await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: ids })
    .expect(201);
  await ctx.prisma.location.update({
    where: { id: salon.locationId },
    data: { onlineBookingEnabled: true, ...LEGAL_TEXTS, city, languages: ['pl'], ...place },
  });
  return salon.slug;
}

const slugs = (body: { items: { slug: string }[] }) => body.items.map((s) => s.slug);

describe('catalogue search (task 180b)', () => {
  it('folds case and accents the way the apps do', () => {
    expect(fold('  Łódź ')).toBe('lodz');
    expect(fold('Strzyżenie BRODY')).toBe('strzyzenie brody');
    expect(matchesSearch('strzyzenie lodz', ['Barber Łódź', 'Strzyżenie męskie'])).toBe(true);
    expect(matchesSearch('manicure', ['Barber Łódź', 'Strzyżenie męskie'])).toBe(false);
    // Warsaw - Kraków is about 252 km.
    const km = distanceKm(
      { latitude: 52.2297, longitude: 21.0122 },
      { latitude: 50.0647, longitude: 19.945 },
    );
    expect(km).toBeGreaterThan(245);
    expect(km).toBeLessThan(260);
  });

  it("finds salons by a service or the salon's name and by city, without accents", async () => {
    const owner = await signUp(ctx, 'search@example.com');
    const barber = await salonWith(owner, 'Gestalt Barbershop', 'Warszawa', [
      'Strzyżenie męskie',
      'Broda',
    ]);
    const nails = await salonWith(owner, 'Paznokcie Ola', 'Łódź', ['Manicure hybrydowy']);
    const hidden = await salonWith(owner, 'Ukryty Barber', 'Warszawa', ['Strzyżenie']);
    await ctx.prisma.location.updateMany({
      where: { slug: hidden },
      data: { onlineBookingEnabled: false },
    });
    // A hidden (inactive) service is not something the salon offers.
    await salonWith(owner, 'Studio Urody', 'Kraków', ['Henna brwi']);
    await ctx.prisma.service.updateMany({
      where: { name: 'Henna brwi' },
      data: { active: false },
    });
    await ctx.prisma.service.create({
      data: {
        locationId: (await ctx.prisma.location.findFirstOrThrow({ where: { slug: barber } })).id,
        name: 'Henna (ukryta)',
        durationMinutes: 15,
        priceGrosze: 1000,
        active: false,
      },
    });

    const byService = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ q: 'STRZYZENIE' })
      .expect(200);
    expect(slugs(byService.body)).toEqual([barber]);
    expect(byService.body.total).toBe(1);
    // The chips count only what was found.
    expect(byService.body.languageCounts.pl).toBe(1);
    expect(
      registeredResponseSchema('PublicSalonDirectory').safeParse(byService.body).error?.issues ??
        [],
    ).toEqual([]);
    expect(byService.body.items[0].distanceKm).toBeNull();

    const byName = await ctx.http().get('/v1/public/locations').query({ q: 'ola' }).expect(200);
    expect(slugs(byName.body)).toEqual([nails]);

    // Several words: each one in the name or a service.
    const twoWords = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ q: 'gestalt broda' })
      .expect(200);
    expect(slugs(twoWords.body)).toEqual([barber]);

    const byCity = await ctx.http().get('/v1/public/locations').query({ city: 'lodz' }).expect(200);
    expect(slugs(byCity.body)).toEqual([nails]);

    const nothing = await ctx.http().get('/v1/public/locations').query({ q: 'henna' }).expect(200);
    expect(nothing.body).toMatchObject({ items: [], total: 0, pageCount: 0 });
    expect(nothing.body.languageCounts.pl).toBe(0);

    const cityAndService = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ q: 'manicure', city: 'warszawa' })
      .expect(200);
    expect(cityAndService.body.total).toBe(0);
  });

  it('puts the nearest salons first, with the distance; salons without a place last', async () => {
    const owner = await signUp(ctx, 'near@example.com');
    const krakow = await salonWith(owner, 'A Kraków', 'Kraków', ['Strzyżenie'], {
      latitude: 50.0647,
      longitude: 19.945,
    });
    const nowhere = await salonWith(owner, 'B Bez mapy', 'Gdańsk', ['Strzyżenie']);
    const praga = await salonWith(owner, 'C Praga', 'Warszawa', ['Strzyżenie'], {
      latitude: 52.25,
      longitude: 21.04,
    });
    const centrum = await salonWith(owner, 'D Centrum', 'Warszawa', ['Strzyżenie'], {
      latitude: 52.2297,
      longitude: 21.0122,
    });

    const first = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ near: '52.2297,21.0122', pageSize: 2 })
      .expect(200);
    expect(slugs(first.body)).toEqual([centrum, praga]);
    expect(first.body.items[0].distanceKm).toBe(0);
    expect(first.body.items[1].distanceKm).toBeGreaterThan(1);
    expect(first.body.items[1].distanceKm).toBeLessThan(5);
    expect(first.body).toMatchObject({ total: 4, pageCount: 2 });

    const second = await ctx
      .http()
      .get('/v1/public/locations')
      .query({ near: '52.2297,21.0122', pageSize: 2, page: 2 })
      .expect(200);
    expect(slugs(second.body)).toEqual([krakow, nowhere]);
    expect(second.body.items[1].distanceKm).toBeNull();

    // Without "near": the usual order by city and name.
    const plain = await ctx.http().get('/v1/public/locations').expect(200);
    expect(slugs(plain.body)).toEqual([nowhere, krakow, praga, centrum]);
  });

  it('rejects a broken place and too long words', async () => {
    for (const query of [
      { near: 'warszawa' },
      { near: '95,21' },
      { near: '52.2,200' },
      { q: 'x'.repeat(81) },
    ]) {
      const response = await ctx.http().get('/v1/public/locations').query(query).expect(400);
      expectError(response.body, 'VALIDATION_ERROR');
    }
  });
});
