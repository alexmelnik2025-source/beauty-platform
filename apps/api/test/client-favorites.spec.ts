import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const ANNA = 'anna.client@example.com';
const BOB = 'bob.client@example.com';

interface Salon {
  owner: SignedInUser;
  base: string;
  slug: string;
}

let ctx: TestContext;

/** A salon with a service and a specialist; online booking on unless `online` is false. */
async function setupSalon(ownerEmail: string, orgName: string, online = true): Promise<Salon> {
  const owner = await signUp(ctx, ownerEmail);
  const { orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, orgName);
  const base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
    .expect(201);
  await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
    .expect(201);
  if (online) await setOnline({ owner, base, slug }, true);
  return { owner, base, slug };
}

async function setOnline(salon: Salon, on: boolean): Promise<void> {
  const loc = await ctx.http().get(salon.base).set(salon.owner.auth).expect(200);
  await ctx
    .http()
    .patch(salon.base)
    .set(salon.owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: on, ...LEGAL_TEXTS })
    .expect(200);
}

/** Signs in through the app (mobile) and returns the auth header. */
async function signIn(email: string): Promise<{ Authorization: string }> {
  await ctx.http().post('/v1/client/auth/code').send({ email, locale: 'pl' }).expect(202);
  const code = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/)?.[1];
  const res = await ctx
    .http()
    .post('/v1/client/auth/verify')
    .send({ email, code, clientType: 'mobile' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

const list = (auth: { Authorization: string }) =>
  ctx.http().get('/v1/client/favorites').set(auth).expect(200);

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

describe('client app: favourite salons', () => {
  let first: Salon;
  let second: Salon;

  beforeEach(async () => {
    await resetState(ctx);
    first = await setupSalon('owner1@example.com', 'Barber One');
    second = await setupSalon('owner2@example.com', 'Barber Two');
  });

  it('needs a client session', async () => {
    await ctx.http().get('/v1/client/favorites').expect(401);
    await ctx.http().put(`/v1/client/favorites/${first.slug}`).expect(401);
    await ctx.http().delete(`/v1/client/favorites/${first.slug}`).expect(401);
  });

  it('adds, lists newest first with public data only, and removes', async () => {
    const anna = await signIn(ANNA);
    expect((await list(anna)).body).toEqual({ items: [] });

    await ctx.http().put(`/v1/client/favorites/${first.slug}`).set(anna).expect(204);
    await ctx.http().put(`/v1/client/favorites/${second.slug}`).set(anna).expect(204);
    const both = await list(anna);
    expect(both.body.items.map((s: { slug: string }) => s.slug)).toEqual([second.slug, first.slug]);
    expect(Object.keys(both.body.items[0]).sort()).toEqual([
      'addedAt',
      'addressLine',
      'bookable',
      'city',
      'name',
      'postalCode',
      'slug',
      'timezone',
      'todayHours',
    ]);
    expect(both.body.items[0]).toMatchObject({ bookable: true });

    await ctx.http().delete(`/v1/client/favorites/${second.slug}`).set(anna).expect(204);
    expect((await list(anna)).body.items.map((s: { slug: string }) => s.slug)).toEqual([
      first.slug,
    ]);
    // Removing again (or a salon that does not exist) is not an error.
    await ctx.http().delete(`/v1/client/favorites/${second.slug}`).set(anna).expect(204);
    await ctx.http().delete('/v1/client/favorites/no-such-salon').set(anna).expect(204);
  });

  it('adding twice keeps one entry with the first date', async () => {
    const anna = await signIn(ANNA);
    await ctx.http().put(`/v1/client/favorites/${first.slug}`).set(anna).expect(204);
    const before = (await list(anna)).body.items[0].addedAt;
    await ctx.http().put(`/v1/client/favorites/${first.slug}`).set(anna).expect(204);
    const after = await list(anna);
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].addedAt).toBe(before);
  });

  it('only salons open for online booking can be added; one that closes stays, not bookable', async () => {
    const anna = await signIn(ANNA);
    const closed = await setupSalon('owner3@example.com', 'Barber Closed', false);
    expectError(
      (await ctx.http().put(`/v1/client/favorites/${closed.slug}`).set(anna).expect(404)).body,
      'NOT_FOUND',
    );
    expectError(
      (await ctx.http().put('/v1/client/favorites/no-such-salon').set(anna).expect(404)).body,
      'NOT_FOUND',
    );

    await ctx.http().put(`/v1/client/favorites/${first.slug}`).set(anna).expect(204);
    await setOnline(first, false);
    expect((await list(anna)).body.items).toEqual([
      expect.objectContaining({ slug: first.slug, bookable: false }),
    ]);
  });

  it('shows today’s real hours of each bookable salon for "Otwarte teraz" (task 367)', async () => {
    const anna = await signIn(ANNA);
    const kasia = async (salon: Salon) => {
      const staff = await ctx.http().get(`${salon.base}/staff`).set(salon.owner.auth).expect(200);
      return (staff.body as { id: string; displayName: string }[]).find(
        (s) => s.displayName === 'Kasia',
      )!.id;
    };
    for (const salon of [first, second]) {
      await ctx
        .http()
        .put(`${salon.base}/staff/${await kasia(salon)}/working-hours`)
        .set(salon.owner.auth)
        .send({
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '09:00', end: '17:00' }],
          })),
        })
        .expect(200);
      await ctx.http().put(`/v1/client/favorites/${salon.slug}`).set(anna).expect(204);
    }
    // The second salon closes for the whole of today ("Salon zamknięty").
    const location = await ctx.prisma.location.findFirstOrThrow({ where: { slug: second.slug } });
    await ctx.prisma.timeBlock.create({
      data: {
        locationId: location.id,
        startAt: new Date(Date.now() - 2 * 86_400_000),
        endAt: new Date(Date.now() + 2 * 86_400_000),
        reason: 'Remont',
      },
    });
    const card = async (slug: string) =>
      ((await list(anna)).body.items as { slug: string }[]).find((s) => s.slug === slug);
    expect(await card(first.slug)).toMatchObject({
      timezone: 'Europe/Warsaw',
      todayHours: [{ start: '09:00', end: '17:00' }],
    });
    expect(await card(second.slug)).toMatchObject({ todayHours: [] });
    // Online booking paused: no hours on the greyed-out card.
    await setOnline(first, false);
    expect(await card(first.slug)).toMatchObject({ bookable: false, todayHours: [] });
  });

  it('each client sees only their own list; salons do not see who saved them', async () => {
    const anna = await signIn(ANNA);
    const bob = await signIn(BOB);
    await ctx.http().put(`/v1/client/favorites/${first.slug}`).set(anna).expect(204);
    await ctx.http().put(`/v1/client/favorites/${second.slug}`).set(bob).expect(204);

    expect((await list(anna)).body.items.map((s: { slug: string }) => s.slug)).toEqual([
      first.slug,
    ]);
    expect((await list(bob)).body.items.map((s: { slug: string }) => s.slug)).toEqual([
      second.slug,
    ]);
    // Bob removing Anna's salon from his (empty for it) list does not touch hers.
    await ctx.http().delete(`/v1/client/favorites/${first.slug}`).set(bob).expect(204);
    expect((await list(anna)).body.items).toHaveLength(1);
    // A salon account cannot read the client list.
    await ctx.http().get('/v1/client/favorites').set(first.owner.auth).expect(401);
  });

  it('signing out ends access to the list', async () => {
    const anna = await signIn(ANNA);
    await ctx.http().put(`/v1/client/favorites/${first.slug}`).set(anna).expect(204);
    await ctx.http().post('/v1/client/auth/logout').set(anna).expect(204);
    await ctx.http().get('/v1/client/favorites').set(anna).expect(401);
  });
});
