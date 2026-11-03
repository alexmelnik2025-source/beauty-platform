import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  codeFromEmail,
  createOrgWithLocation,
  createTestApp,
  expectError,
  PASSWORD,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let kasiaId: string;

const requestCode = (email: string, locale = 'pl') =>
  ctx.http().post('/v1/auth/code').send({ email, locale });

const verify = (body: Record<string, unknown>) =>
  ctx.http().post('/v1/auth/code/verify').send(body);

const invite = (body: object, auth = owner.auth) =>
  ctx.http().post(`/v1/organizations/${orgId}/invitations`).set(auth).send(body);

const me = (accessToken: string) =>
  ctx
    .http()
    .get('/v1/me')
    .set({ Authorization: `Bearer ${accessToken}` })
    .expect(200);

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  kasiaId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia' })
      .expect(201)
  ).body.id;
});

describe('sign-in with an email code (business app)', () => {
  it('an invited staff member signs in with a code and lands in the salon with the role', async () => {
    await invite({
      email: 'kasia@example.com',
      role: 'staff',
      locationIds: [locationId],
      staffMemberId: kasiaId,
      locale: 'uk',
    }).expect(201);

    const sent = await requestCode('Kasia@Example.com', 'uk').expect(202);
    expect(Date.parse(sent.body.codeExpiresAt)).toBeGreaterThan(Date.now());
    const message = ctx.mail.lastTo('kasia@example.com');
    expect(message?.subject).toBe('Код входу до застосунку салону');

    const res = await verify({
      email: 'kasia@example.com',
      code: codeFromEmail(ctx, 'kasia@example.com'),
      clientType: 'mobile',
      deviceName: 'iPhone Kasi',
      locale: 'uk',
    }).expect(200);
    // Mobile: the refresh token comes in the body, not as a cookie.
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.user).toMatchObject({
      email: 'kasia@example.com',
      name: 'Kasia',
      locale: 'uk',
      emailVerified: true,
    });

    const profile = await me(res.body.accessToken);
    expect(profile.body.organizations).toEqual([{ id: orgId, name: 'Barber', role: 'staff' }]);
    const staff = await ctx.prisma.staffMember.findUniqueOrThrow({ where: { id: kasiaId } });
    expect(staff.userId).toBe(res.body.user.id);
    const invitation = await ctx.prisma.invitation.findFirstOrThrow({
      where: { email: 'kasia@example.com' },
    });
    expect(invitation.acceptedAt).not.toBeNull();

    // The account works on the next sign-in too, and the mobile refresh token rotates.
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: res.body.refreshToken })
      .expect(200);
    await requestCode('kasia@example.com').expect(202);
    await verify({
      email: 'kasia@example.com',
      code: codeFromEmail(ctx, 'kasia@example.com'),
    }).expect(200);
  });

  it('an invited manager gets the manager role and only the invited locations', async () => {
    const second = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({
        name: 'Barber Wola',
        addressLine: 'ul. Wolska 1',
        city: 'Warszawa',
        postalCode: '01-001',
      })
      .expect(201);
    await invite({
      email: 'manager@example.com',
      role: 'manager',
      locationIds: [second.body.id],
    }).expect(201);
    await requestCode('manager@example.com').expect(202);
    const res = await verify({
      email: 'manager@example.com',
      code: codeFromEmail(ctx, 'manager@example.com'),
      name: 'Marek',
    }).expect(200);
    expect(res.body.user.name).toBe('Marek');
    // Web: the refresh token is a cookie, not in the body.
    expect(res.body.refreshToken).toBeUndefined();
    expect(String(res.headers['set-cookie'])).toContain('bp_refresh=');

    const membership = await ctx.prisma.membership.findFirstOrThrow({
      where: { userId: res.body.user.id },
      include: { locations: true },
    });
    expect(membership.role).toBe('manager');
    expect(membership.locations.map((l) => l.locationId)).toEqual([second.body.id]);
  });

  it('an existing account (owner) can sign in with a code instead of the password', async () => {
    await requestCode('owner@example.com').expect(202);
    const res = await verify({
      email: 'owner@example.com',
      code: codeFromEmail(ctx, 'owner@example.com'),
    }).expect(200);
    expect(res.body.user.id).toBe(owner.userId);
    const profile = await me(res.body.accessToken);
    expect(profile.body.organizations).toEqual([{ id: orgId, name: 'Barber', role: 'owner' }]);
    // The password keeps working.
    await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'owner@example.com', password: PASSWORD })
      .expect(200);
  });

  it('an existing account joins every pending invitation on code sign-in', async () => {
    const kasia = await signUp(ctx, 'kasia@example.com', 'Kasia K.');
    await invite({
      email: 'kasia@example.com',
      role: 'staff',
      locationIds: [locationId],
      staffMemberId: kasiaId,
    }).expect(201);
    await requestCode('kasia@example.com').expect(202);
    const res = await verify({
      email: 'kasia@example.com',
      code: codeFromEmail(ctx, 'kasia@example.com'),
    }).expect(200);
    expect(res.body.user).toMatchObject({ id: kasia.userId, name: 'Kasia K.' });
    expect((await me(res.body.accessToken)).body.organizations).toEqual([
      { id: orgId, name: 'Barber', role: 'staff' },
    ]);
  });

  it('nobody can sign themselves up: no account and no invitation means no code', async () => {
    const res = await requestCode('stranger@example.com').expect(202);
    // Same answer as for a real account.
    expect(res.body).toEqual({ codeExpiresAt: expect.any(String), channel: 'email' });
    expect(ctx.mail.lastTo('stranger@example.com')).toBeUndefined();
    expectError(
      (await verify({ email: 'stranger@example.com', code: '123456' }).expect(400)).body,
      'CODE_NOT_SENT',
    );
    expect(await ctx.prisma.user.count({ where: { email: 'stranger@example.com' } })).toBe(0);
  });

  it('a cancelled or expired invitation gives no account', async () => {
    const sent = await invite({
      email: 'kasia@example.com',
      role: 'staff',
      locationIds: [locationId],
    }).expect(201);
    await requestCode('kasia@example.com').expect(202);
    const code = codeFromEmail(ctx, 'kasia@example.com');
    // Cancelled after the code was sent.
    await ctx
      .http()
      .delete(`/v1/organizations/${orgId}/invitations/${sent.body.id}`)
      .set(owner.auth)
      .expect(204);
    expectError(
      (await verify({ email: 'kasia@example.com', code }).expect(403)).body,
      'NO_INVITATION',
    );
    expect(await ctx.prisma.user.count({ where: { email: 'kasia@example.com' } })).toBe(0);

    // Expired invitation: no code at all.
    await invite({ email: 'ola@example.com', role: 'staff', locationIds: [locationId] }).expect(
      201,
    );
    await ctx.prisma.invitation.updateMany({
      where: { email: 'ola@example.com' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    ctx.mail.clear();
    await requestCode('ola@example.com').expect(202);
    expect(ctx.mail.lastTo('ola@example.com')).toBeUndefined();
  });

  it('codes are single use, expire and lock after 5 wrong attempts', async () => {
    await requestCode('owner@example.com').expect(202);
    const code = codeFromEmail(ctx, 'owner@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await verify({ email: 'owner@example.com', code: wrong }).expect(400);
    expectError(first.body, 'INVALID_CODE');
    expect(first.body.error.details[0].message).toBe('4 attempts left');
    for (let i = 0; i < 4; i += 1) {
      await verify({ email: 'owner@example.com', code: wrong }).expect(400);
    }
    // Even the right code no longer works.
    expectError(
      (await verify({ email: 'owner@example.com', code }).expect(429)).body,
      'TOO_MANY_ATTEMPTS',
    );

    // A new code replaces the old one and works once.
    await requestCode('owner@example.com').expect(202);
    const fresh = codeFromEmail(ctx, 'owner@example.com');
    await verify({ email: 'owner@example.com', code: fresh }).expect(200);
    expectError(
      (await verify({ email: 'owner@example.com', code: fresh }).expect(400)).body,
      'CODE_NOT_SENT',
    );

    await requestCode('owner@example.com').expect(202);
    await ctx.prisma.staffLoginCode.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expectError(
      (
        await verify({
          email: 'owner@example.com',
          code: codeFromEmail(ctx, 'owner@example.com'),
        }).expect(410)
      ).body,
      'CODE_EXPIRED',
    );
  });

  it('a salon-account code does not sign in to the client app and vice versa', async () => {
    await requestCode('owner@example.com').expect(202);
    const code = codeFromEmail(ctx, 'owner@example.com');
    await ctx
      .http()
      .post('/v1/client/auth/verify')
      .send({ email: 'owner@example.com', code })
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    // The salon code is still valid afterwards.
    await verify({ email: 'owner@example.com', code }).expect(200);
  });

  it('limits code emails per address', async () => {
    for (let i = 0; i < 4; i += 1) {
      await requestCode('owner@example.com').expect(202);
    }
    // signUp already sent one email to this address in the same hour.
    expectError((await requestCode('owner@example.com').expect(429)).body, 'RATE_LIMITED');
  });
});
