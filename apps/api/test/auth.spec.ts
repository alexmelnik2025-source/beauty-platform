import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/auth/access-token.service';
import {
  codeFromEmail,
  createTestApp,
  expectError,
  PASSWORD,
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

const register = (email: string, extra: Record<string, unknown> = {}) =>
  ctx
    .http()
    .post('/v1/auth/register')
    .send({ email, password: PASSWORD, name: 'Anna', ...extra });

describe('registration and email confirmation', () => {
  it('sends a confirmation email in the chosen language and blocks login until confirmed', async () => {
    await register('Anna@Example.com ', { locale: 'uk' }).expect(202);

    const message = ctx.mail.lastTo('anna@example.com');
    expect(message?.subject).toBe('Підтвердіть адресу електронної пошти');
    expect(message?.text).toContain('http://localhost:3000/verify-email?token=');

    const res = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: PASSWORD })
      .expect(403);
    expectError(res.body, 'EMAIL_NOT_VERIFIED');
  });

  it('stores the email lower-cased and never stores the password itself', async () => {
    await register('Anna@Example.com').expect(202);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'anna@example.com' } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it('answers the same for an existing email and does not create a duplicate', async () => {
    await register('anna@example.com').expect(202);
    const sentBefore = ctx.mail.sent.length;
    const res = await register('anna@example.com', { name: 'Someone Else' }).expect(202);
    expect(res.body).toEqual({ message: expect.any(String) });
    expect(ctx.mail.sent.length).toBe(sentBefore);
    expect(await ctx.prisma.user.count()).toBe(1);
  });

  it('accepts a confirmation code only once', async () => {
    await register('anna@example.com').expect(202);
    const code = codeFromEmail(ctx, 'anna@example.com');
    await ctx.http().post('/v1/auth/verify-email').send({ token: code }).expect(200);
    const res = await ctx.http().post('/v1/auth/verify-email').send({ token: code }).expect(400);
    expectError(res.body, 'INVALID_TOKEN');
  });

  it('invalidates the previous code when a new one is requested', async () => {
    await register('anna@example.com').expect(202);
    const first = codeFromEmail(ctx, 'anna@example.com');
    await ctx
      .http()
      .post('/v1/auth/resend-verification')
      .send({ email: 'anna@example.com' })
      .expect(202);
    const second = codeFromEmail(ctx, 'anna@example.com');
    expect(second).not.toBe(first);
    await ctx.http().post('/v1/auth/verify-email').send({ token: first }).expect(400);
    await ctx.http().post('/v1/auth/verify-email').send({ token: second }).expect(200);
  });

  it('rejects weak input with field-level details', async () => {
    const res = await ctx
      .http()
      .post('/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', name: '' })
      .expect(400);
    expectError(res.body, 'VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'name']));
  });
});

describe('login', () => {
  it('web: refresh token only in an httpOnly, SameSite=Strict cookie scoped to /v1/auth', async () => {
    await signUp(ctx, 'anna@example.com');
    const res = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: PASSWORD })
      .expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/bp_refresh=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
  });

  it('mobile: refresh token in the body, no cookie', async () => {
    await signUp(ctx, 'anna@example.com');
    const res = await ctx
      .http()
      .post('/v1/auth/login')
      .send({
        email: 'anna@example.com',
        password: PASSWORD,
        clientType: 'mobile',
        deviceName: 'iPhone',
      })
      .expect(200);
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    await signUp(ctx, 'anna@example.com');
    const wrong = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: 'wrong-password-123' })
      .expect(401);
    const unknown = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password-123' })
      .expect(401);
    expectError(wrong.body, 'INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('limits repeated login attempts for one email', async () => {
    await signUp(ctx, 'anna@example.com');
    const attempt = () =>
      ctx
        .http()
        .post('/v1/auth/login')
        .send({ email: 'anna@example.com', password: 'wrong-password-123' });
    // signUp already used one attempt; 9 more are allowed.
    for (let i = 0; i < 9; i += 1) {
      await attempt().expect(401);
    }
    const res = await attempt().expect(429);
    expectError(res.body, 'RATE_LIMITED');
  });
});

describe('access tokens', () => {
  it('protects every non-public route', async () => {
    const res = await ctx.http().get('/v1/me').expect(401);
    expectError(res.body, 'UNAUTHORIZED');
  });

  it('returns the signed-in user', async () => {
    const user = await signUp(ctx, 'anna@example.com', 'Anna Nowak');
    const res = await ctx.http().get('/v1/me').set(user.auth).expect(200);
    expect(res.body.user).toMatchObject({
      email: 'anna@example.com',
      name: 'Anna Nowak',
      emailVerified: true,
    });
    expect(res.body.organizations).toEqual([]);
  });

  it('rejects tampered and expired tokens', async () => {
    const user = await signUp(ctx, 'anna@example.com');
    const [header, payload, signature] = user.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const forged = Buffer.from(
      JSON.stringify({ ...claims, sub: '00000000-0000-7000-8000-000000000000' }),
    ).toString('base64url');
    await ctx
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${header}.${forged}.${signature}`)
      .expect(401);

    const tokens = ctx.app.get(AccessTokenService);
    const expired = tokens.sign(
      { userId: user.userId, sessionId: claims.sid },
      Date.now() - 16 * 60 * 1000,
    );
    await ctx.http().get('/v1/me').set('Authorization', `Bearer ${expired}`).expect(401);
  });
});

describe('refresh tokens and sessions', () => {
  async function mobileLogin(): Promise<{ accessToken: string; refreshToken: string }> {
    await signUp(ctx, 'anna@example.com');
    const res = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: PASSWORD, clientType: 'mobile' })
      .expect(200);
    return res.body;
  }

  it('rotates the refresh token on every use', async () => {
    const first = await mobileLogin();
    const res = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
    await ctx
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
  });

  it('revokes the whole session when an old refresh token is reused (token theft)', async () => {
    const first = await mobileLogin();
    const second = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);

    const reuse = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    expectError(reuse.body, 'INVALID_REFRESH_TOKEN');
    // The legitimate newer token is now dead too.
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(401);
  });

  it('lets only one of two simultaneous refreshes with the same token succeed', async () => {
    const first = await mobileLogin();
    const results = await Promise.all([
      ctx.http().post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }),
      ctx.http().post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('web: refreshes using the cookie', async () => {
    await signUp(ctx, 'anna@example.com');
    const agent = ctx.http();
    const login = await agent
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: PASSWORD });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await ctx
      .http()
      .post('/v1/auth/refresh')
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    expect(String(res.headers['set-cookie'])).toMatch(/bp_refresh=/);
  });

  it('logout ends the session', async () => {
    await signUp(ctx, 'anna@example.com');
    const login = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: PASSWORD, clientType: 'mobile' });
    await ctx
      .http()
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(204);
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });

  it('lists devices and signs out another one', async () => {
    const web = await signUp(ctx, 'anna@example.com');
    const phone = await ctx.http().post('/v1/auth/login').send({
      email: 'anna@example.com',
      password: PASSWORD,
      clientType: 'mobile',
      deviceName: 'iPhone 15',
    });

    const list = await ctx.http().get('/v1/me/sessions').set(web.auth).expect(200);
    expect(list.body).toHaveLength(2);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    expect(other.deviceName).toBe('iPhone 15');

    await ctx.http().delete(`/v1/me/sessions/${other.id}`).set(web.auth).expect(204);
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: phone.body.refreshToken })
      .expect(401);
  });
});

describe('password reset', () => {
  it('sets a new password, signs out all devices and works only once', async () => {
    await signUp(ctx, 'anna@example.com');
    const phone = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: PASSWORD, clientType: 'mobile' });

    await ctx
      .http()
      .post('/v1/auth/forgot-password')
      .send({ email: 'anna@example.com' })
      .expect(202);
    const code = codeFromEmail(ctx, 'anna@example.com');
    await ctx
      .http()
      .post('/v1/auth/reset-password')
      .send({ token: code, newPassword: 'a-brand-new-password' })
      .expect(200);

    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: phone.body.refreshToken })
      .expect(401);
    await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: PASSWORD })
      .expect(401);
    await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'anna@example.com', password: 'a-brand-new-password' })
      .expect(200);

    const again = await ctx
      .http()
      .post('/v1/auth/reset-password')
      .send({ token: code, newPassword: 'yet-another-password' })
      .expect(400);
    expectError(again.body, 'INVALID_TOKEN');
  });

  it('does not reveal whether an email is registered', async () => {
    const res = await ctx
      .http()
      .post('/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' })
      .expect(202);
    expect(res.body).toEqual({ message: expect.any(String) });
    expect(ctx.mail.sent).toHaveLength(0);
  });

  it('a verification code cannot be used to reset a password', async () => {
    await register('anna@example.com').expect(202);
    const verifyCode = codeFromEmail(ctx, 'anna@example.com');
    await ctx
      .http()
      .post('/v1/auth/reset-password')
      .send({ token: verifyCode, newPassword: 'a-brand-new-password' })
      .expect(400);
  });
});
