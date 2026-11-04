import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOKING_TERMS_TEMPLATE_PL,
  PRIVACY_POLICY_TEMPLATE_PL,
} from '../src/organizations/legal-templates';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LEGAL_TEXTS,
  LOCATION,
  resetState,
  signUp,
  type TestContext,
} from './helpers';

/** Launch task L1: the salon's booking terms and privacy policy. */
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

async function salon() {
  const owner = await signUp(ctx, 'owner@example.com');
  const ids = await createOrgWithLocation(ctx, owner, 'GESTALT');
  const base = `/v1/organizations/${ids.orgId}/locations/${ids.locationId}`;
  return { owner, ...ids, base };
}

async function version(base: string, auth: Record<string, string>): Promise<number> {
  const res = await ctx.http().get(base).set(auth).expect(200);
  return res.body.version;
}

describe('legal texts of a salon', () => {
  it('the templates in the code are the ones in docs/legal', () => {
    const docs = resolve(__dirname, '../../../docs/legal');
    expect(BOOKING_TERMS_TEMPLATE_PL).toBe(
      readFileSync(resolve(docs, 'regulamin-rezerwacji.pl.md'), 'utf8'),
    );
    expect(PRIVACY_POLICY_TEMPLATE_PL).toBe(
      readFileSync(resolve(docs, 'polityka-prywatnosci.pl.md'), 'utf8'),
    );
  });

  it('online booking cannot be switched on without both texts', async () => {
    const { owner, base } = await salon();

    const without = await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 1, onlineBookingEnabled: true })
      .expect(422);
    expectError(without.body, 'LEGAL_TEXTS_REQUIRED');

    const onlyTerms = await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 1, onlineBookingEnabled: true, bookingTerms: LEGAL_TEXTS.bookingTerms })
      .expect(422);
    expectError(onlyTerms.body, 'LEGAL_TEXTS_REQUIRED');

    // Nothing was saved by the refused requests.
    const unchanged = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(unchanged.body).toMatchObject({
      version: 1,
      onlineBookingEnabled: false,
      bookingTerms: null,
      privacyPolicy: null,
    });

    const ok = await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 1, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(200);
    expect(ok.body).toMatchObject({ onlineBookingEnabled: true, ...LEGAL_TEXTS });
  });

  it('texts can be written first and booking switched on later', async () => {
    const { owner, base } = await salon();
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 1, ...LEGAL_TEXTS })
      .expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 2, onlineBookingEnabled: true })
      .expect(200);
  });

  it('a text cannot be removed while booking is on, but can after switching it off', async () => {
    const { owner, base } = await salon();
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 1, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(200);

    const emptied = await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 2, privacyPolicy: '   ' })
      .expect(422);
    expectError(emptied.body, 'LEGAL_TEXTS_REQUIRED');

    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 2, onlineBookingEnabled: false, privacyPolicy: '' })
      .expect(200)
      .expect((res) => expect(res.body.privacyPolicy).toBeNull());
  });

  it('a new location cannot start with online booking on without the texts', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await ctx
      .http()
      .post('/v1/organizations')
      .set(owner.auth)
      .send({ name: 'GESTALT' })
      .expect(201);
    const refused = await ctx
      .http()
      .post(`/v1/organizations/${org.body.id}/locations`)
      .set(owner.auth)
      .send({ ...LOCATION, onlineBookingEnabled: true })
      .expect(422);
    expectError(refused.body, 'LEGAL_TEXTS_REQUIRED');
    expect(await ctx.prisma.location.count()).toBe(0);

    await ctx
      .http()
      .post(`/v1/organizations/${org.body.id}/locations`)
      .set(owner.auth)
      .send({ ...LOCATION, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(201);
  });

  it('a salon that already took bookings before the texts keeps working', async () => {
    const { owner, locationId, base } = await salon();
    await ctx.prisma.location.update({
      where: { id: locationId },
      data: { onlineBookingEnabled: true },
    });
    // The settings form always sends the switch: saving other fields still works.
    const current = await version(base, owner.auth);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: current, onlineBookingEnabled: true, city: 'Kraków' })
      .expect(200);
  });

  it('templates come with the salon details filled in, for the owner and its manager only', async () => {
    const { owner, orgId, locationId, slug, base } = await salon();
    await ctx
      .http()
      .patch(`/v1/organizations/${orgId}`)
      .set(owner.auth)
      .send({ nip: '5250000000' });
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 1, phone: '+48123456789', email: 'salon@example.com' })
      .expect(200);

    const res = await ctx.http().get(`${base}/legal-templates`).set(owner.auth).expect(200);
    const { bookingTerms, privacyPolicy, missing } = res.body;
    expect(bookingTerms).toContain('# Regulamin rezerwacji online — GESTALT Centrum');
    expect(bookingTerms).toContain('ul. Puławska 1, 02-515 Warszawa');
    expect(bookingTerms).toContain('NIP 5250000000');
    expect(bookingTerms).toContain('telefon +48123456789, e-mail salon@example.com');
    // Default change deadline: 120 minutes = 2 hours.
    expect(bookingTerms).toContain('2 godzin przed wizytą');
    expect(bookingTerms).toContain(`/pl/b/${slug}/privacy`);
    expect(privacyPolicy).toContain('Administratorem danych jest GESTALT,');
    // What only the salon knows stays to be filled in.
    expect(missing).toEqual(expect.arrayContaining(['{KRS}', '{ADRES_FIRMY}', '{DATA}']));
    expect(missing).not.toContain('{NAZWA_SALONU}');
    expect(missing).not.toContain('{NIP}');
    for (const placeholder of missing) {
      expect(`${bookingTerms}${privacyPolicy}`).toContain(placeholder);
    }
    // Nothing was saved.
    expect(
      await ctx.prisma.location.findUniqueOrThrow({ where: { id: locationId } }),
    ).toMatchObject({ bookingTerms: null, privacyPolicy: null });

    const staff = await signUp(ctx, 'staff@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: staff.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.http().get(`${base}/legal-templates`).set(staff.auth).expect(403);

    const stranger = await signUp(ctx, 'other@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Other');
    await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/locations/${locationId}/legal-templates`)
      .set(stranger.auth)
      .expect(404);
  });

  it('clients read the texts on the public salon page, only while booking is on', async () => {
    const { owner, slug, base } = await salon();
    await ctx.http().get(`/v1/public/locations/${slug}/legal`).expect(404);

    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: 1, onlineBookingEnabled: true, ...LEGAL_TEXTS })
      .expect(200);
    const res = await ctx.http().get(`/v1/public/locations/${slug}/legal`).expect(200);
    expect(res.body).toEqual({
      name: 'GESTALT Centrum',
      ...LEGAL_TEXTS,
      updatedAt: expect.any(String),
    });
  });
});
