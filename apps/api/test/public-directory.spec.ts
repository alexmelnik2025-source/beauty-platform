import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
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
    await ctx.http().get('/v1/public/locations').query({ language: 'en' }).expect(200, {
      items: [],
      page: 1,
      pageSize: 12,
      total: 0,
      pageCount: 0,
    });
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
