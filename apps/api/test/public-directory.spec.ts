import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
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

describe('public salon directory', () => {
  it('filters by spoken language, paginates and exposes only public salon fields', async () => {
    const owner = await signUp(ctx, 'directory@example.com');
    const polish = await createOrgWithLocation(ctx, owner, 'Polish salon');
    const ukrainian = await createOrgWithLocation(ctx, owner, 'Ukrainian salon');
    const hidden = await createOrgWithLocation(ctx, owner, 'Private salon');

    await ctx.prisma.location.update({
      where: { id: polish.locationId },
      data: {
        onlineBookingEnabled: true,
        languages: ['pl', 'en'],
        latitude: 52.2,
        longitude: 21.0,
      },
    });
    await ctx.prisma.location.update({
      where: { id: ukrainian.locationId },
      data: { onlineBookingEnabled: true, languages: ['uk', 'be'] },
    });
    await ctx.prisma.location.update({
      where: { id: hidden.locationId },
      data: { onlineBookingEnabled: false, languages: ['pl'] },
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
