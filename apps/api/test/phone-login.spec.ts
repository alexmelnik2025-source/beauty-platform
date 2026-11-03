import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  codeFromEmail,
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 11a, part 2: the owner adds a phone number to the invitation; sign-in by that number. */

const PHONE = '+48600100200';

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let kasiaId: string;

const requestCode = (body: Record<string, unknown>) => ctx.http().post('/v1/auth/code').send(body);

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

function smsCode(phone = PHONE): string {
  const match = ctx.sms.lastTo(phone)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no SMS code sent to ${phone}`);
  return match[1];
}

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
  kasiaId = (
    await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations/${locationId}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia' })
      .expect(201)
  ).body.id;
});

const inviteKasia = () =>
  invite({
    email: 'kasia@example.com',
    phone: '+48 600 100 200',
    role: 'staff',
    locationIds: [locationId],
    staffMemberId: kasiaId,
  }).expect(201);

describe('invitation with a phone number', () => {
  it('the owner adds a phone; it is stored in international format and listed', async () => {
    const created = await inviteKasia();
    expect(created.body.phone).toBe(PHONE);
    const list = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/invitations`)
      .set(owner.auth)
      .expect(200);
    expect(list.body[0]).toMatchObject({ email: 'kasia@example.com', phone: PHONE });

    const withoutPhone = await invite({
      email: 'ola@example.com',
      role: 'staff',
      locationIds: [locationId],
    }).expect(201);
    expect(withoutPhone.body.phone).toBeNull();
  });

  it('rejects a number that is not in international format', async () => {
    const res = await invite({
      email: 'kasia@example.com',
      phone: '600100200',
      role: 'staff',
      locationIds: [locationId],
    }).expect(400);
    expectError(res.body, 'VALIDATION_ERROR');
  });
});

describe('sign-in by phone with an SMS gateway', () => {
  it('the invited person gets an SMS and lands in the salon with the role', async () => {
    await inviteKasia();
    const sent = await requestCode({ phone: '+48 600-100-200' }).expect(202);
    expect(sent.body).toEqual({ codeExpiresAt: expect.any(String), channel: 'sms' });
    expect(ctx.sms.lastTo(PHONE)?.text).toContain('Kod logowania');
    // The code goes by SMS only, not by email.
    expect(ctx.mail.lastTo('kasia@example.com')?.subject).not.toBe(
      'Kod logowania do aplikacji salonu',
    );

    const res = await verify({ phone: PHONE, code: smsCode(), clientType: 'mobile' }).expect(200);
    expect(res.body.user).toMatchObject({ email: 'kasia@example.com', name: 'Kasia' });
    // The SMS proves the phone, not the email address.
    expect(res.body.user.emailVerified).toBe(false);
    const profile = await me(res.body.accessToken);
    expect(profile.body.organizations).toEqual([{ id: orgId, name: 'Barber', role: 'staff' }]);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(user.phone).toBe(PHONE);
    const staff = await ctx.prisma.staffMember.findUniqueOrThrow({ where: { id: kasiaId } });
    expect(staff.userId).toBe(user.id);

    // Next time the account itself is found by the number.
    await requestCode({ phone: PHONE }).expect(202);
    await verify({ phone: PHONE, code: smsCode() }).expect(200);
  });

  it('an SMS code also accepts invitations sent to the number under another email', async () => {
    const kasia = await signUp(ctx, 'kasia@example.com', 'Kasia K.');
    const other = await signUp(ctx, 'owner2@example.com');
    const { orgId: secondOrg, locationId: secondLocation } = await createOrgWithLocation(
      ctx,
      other,
      'Salon Mokotów',
    );
    await ctx
      .http()
      .post(`/v1/organizations/${secondOrg}/invitations`)
      .set(other.auth)
      .send({
        email: 'kasia.work@example.com',
        phone: PHONE,
        role: 'manager',
        locationIds: [secondLocation],
      })
      .expect(201);
    await ctx.prisma.user.update({ where: { id: kasia.userId }, data: { phone: PHONE } });

    await requestCode({ phone: PHONE }).expect(202);
    const res = await verify({ phone: PHONE, code: smsCode() }).expect(200);
    expect(res.body.user.id).toBe(kasia.userId);
    const profile = await me(res.body.accessToken);
    expect(profile.body.organizations).toEqual([
      { id: secondOrg, name: 'Salon Mokotów', role: 'manager' },
    ]);
  });

  it('a code requested by phone is entered with the phone, not with the email', async () => {
    await inviteKasia();
    await requestCode({ phone: PHONE }).expect(202);
    const code = smsCode();
    expectError(
      (await verify({ email: 'kasia@example.com', code }).expect(400)).body,
      'CODE_NOT_SENT',
    );
    await verify({ phone: PHONE, code }).expect(200);
  });

  it('wrong codes count, and the code works once', async () => {
    await inviteKasia();
    await requestCode({ phone: PHONE }).expect(202);
    const code = smsCode();
    const wrong = code === '000000' ? '111111' : '000000';
    expectError((await verify({ phone: PHONE, code: wrong }).expect(400)).body, 'INVALID_CODE');
    await verify({ phone: PHONE, code }).expect(200);
    expectError((await verify({ phone: PHONE, code }).expect(400)).body, 'CODE_NOT_SENT');
  });
});

describe('sign-in by phone without an SMS gateway', () => {
  it('the code goes to the email of the invitation with that number', async () => {
    ctx.sms.available = false;
    await inviteKasia();
    const sent = await requestCode({ phone: PHONE, locale: 'ru' }).expect(202);
    expect(sent.body.channel).toBe('email');
    expect(ctx.sms.sent).toHaveLength(0);
    expect(ctx.mail.lastTo('kasia@example.com')?.subject).toBe('Код входа в приложение салона');

    const res = await verify({
      phone: PHONE,
      code: codeFromEmail(ctx, 'kasia@example.com'),
      locale: 'ru',
    }).expect(200);
    // The emailed code proves the address.
    expect(res.body.user).toMatchObject({ email: 'kasia@example.com', emailVerified: true });
    expect((await me(res.body.accessToken)).body.organizations).toEqual([
      { id: orgId, name: 'Barber', role: 'staff' },
    ]);
    // The owner's number is now on the account: the next sign-in by phone finds it.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(user.phone).toBe(PHONE);
  });

  it('an emailed code does not accept invitations sent to the number under another email', async () => {
    ctx.sms.available = false;
    await inviteKasia();
    const other = await signUp(ctx, 'owner2@example.com');
    const { orgId: secondOrg, locationId: secondLocation } = await createOrgWithLocation(
      ctx,
      other,
      'Salon Mokotów',
    );
    // Created later, so the newest invitation with this number points at this address.
    await ctx
      .http()
      .post(`/v1/organizations/${secondOrg}/invitations`)
      .set(other.auth)
      .send({
        email: 'someone@example.com',
        phone: PHONE,
        role: 'staff',
        locationIds: [secondLocation],
      })
      .expect(201);

    await requestCode({ phone: PHONE }).expect(202);
    const res = await verify({
      phone: PHONE,
      code: codeFromEmail(ctx, 'someone@example.com'),
    }).expect(200);
    expect(res.body.user.email).toBe('someone@example.com');
    expect((await me(res.body.accessToken)).body.organizations).toEqual([
      { id: secondOrg, name: 'Salon Mokotów', role: 'staff' },
    ]);
    const first = await ctx.prisma.invitation.findFirstOrThrow({
      where: { email: 'kasia@example.com' },
    });
    expect(first.acceptedAt).toBeNull();
  });
});

describe('nobody signs themselves up by phone', () => {
  it('an unknown number gets the same answer and no code', async () => {
    const res = await requestCode({ phone: '+48700800900' }).expect(202);
    expect(res.body).toEqual({ codeExpiresAt: expect.any(String), channel: 'sms' });
    expect(ctx.sms.sent).toHaveLength(0);
    expect(ctx.mail.sent.filter((m) => m.to !== 'owner@example.com')).toHaveLength(0);
    expectError(
      (await verify({ phone: '+48700800900', code: '123456' }).expect(400)).body,
      'CODE_NOT_SENT',
    );
  });

  it('a revoked invitation no longer lets the number sign in', async () => {
    const created = await inviteKasia();
    await ctx
      .http()
      .delete(`/v1/organizations/${orgId}/invitations/${created.body.id}`)
      .set(owner.auth)
      .expect(204);
    await requestCode({ phone: PHONE }).expect(202);
    expect(ctx.sms.sent).toHaveLength(0);
  });

  it('needs either an email or a phone, not both', async () => {
    expectError((await requestCode({}).expect(400)).body, 'VALIDATION_ERROR');
    expectError(
      (await requestCode({ email: 'kasia@example.com', phone: PHONE }).expect(400)).body,
      'VALIDATION_ERROR',
    );
    expectError((await requestCode({ phone: '12345' }).expect(400)).body, 'VALIDATION_ERROR');
  });
});
