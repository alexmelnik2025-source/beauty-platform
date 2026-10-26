import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

const TZ = 'Europe/Warsaw';
const PHONE = '+48600100200';
const EMAIL = 'anna@example.com';

let ctx: TestContext;
let owner: SignedInUser;
let base: string;
let orgId: string;
let slug: string;
let serviceId: string;
let staffId: string;
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
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  slug = org.slug;
  orgId = org.orgId;
  base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 45, priceGrosze: 8000 })
    .expect(201);
  serviceId = service.body.id;
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [serviceId] })
    .expect(201);
  staffId = staff.body.id;
  await ctx
    .http()
    .put(`${base}/staff/${staffId}/working-hours`)
    .set(owner.auth)
    .send({
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        intervals: [{ start: '09:00', end: '18:00' }],
      })),
    })
    .expect(200);
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

async function newHold(hh = 10): Promise<{ holdId: string; holdToken: string }> {
  const res = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start: at(day, hh) })
    .expect(201);
  return res.body;
}

const sendCode = (
  hold: { holdId: string; holdToken: string },
  extra: Record<string, unknown> = {},
) =>
  ctx
    .http()
    .post(`/v1/public/holds/${hold.holdId}/code`)
    .send({
      holdToken: hold.holdToken,
      name: 'Anna Kowalska',
      phone: '+48 600 100 200',
      email: EMAIL,
      locale: 'pl',
      acceptTerms: true,
      ...extra,
    });

function smsCode(phone = PHONE): string {
  const match = ctx.sms.lastTo(phone)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no SMS code sent to ${phone}`);
  return match[1];
}

describe('booking code by SMS', () => {
  it('the salon page offers SMS when a gateway is connected', async () => {
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.codeChannels).toEqual(['email', 'sms']);
  });

  it('sends the code to the phone (not by email); the visit is booked with it', async () => {
    const hold = await newHold();
    const res = await sendCode(hold, { codeChannel: 'sms' }).expect(202);
    expect(res.body.channel).toBe('sms');
    const sms = ctx.sms.lastTo(PHONE);
    expect(sms?.text).toMatch(/^\d{6} — kod rezerwacji w Barber\. Ważny 10 min\.$/);
    expect(ctx.mail.lastTo(EMAIL)).toBeUndefined();

    const confirmed = await ctx
      .http()
      .post(`/v1/public/holds/${hold.holdId}/confirm`)
      .send({ holdToken: hold.holdToken, code: smsCode(), signIn: true })
      .expect(200);
    expect(confirmed.body.appointment.status).toBe('confirmed');
    // An SMS code does not prove the email: no "My visits" session.
    expect(confirmed.body.signedIn).toBe(false);
    expect(confirmed.headers['set-cookie']).toBeUndefined();
    expect(await ctx.prisma.clientSession.count()).toBe(0);
  });

  it('email stays the default channel', async () => {
    const hold = await newHold();
    const res = await sendCode(hold).expect(202);
    expect(res.body.channel).toBe('email');
    expect(ctx.sms.sent).toHaveLength(0);
    expect(ctx.mail.lastTo(EMAIL)?.subject).toBe('Kod potwierdzenia rezerwacji');
  });

  it('writes the SMS in the language of the client', async () => {
    await sendCode(await newHold(), { codeChannel: 'sms', locale: 'uk' }).expect(202);
    expect(ctx.sms.lastTo(PHONE)?.text).toMatch(/^\d{6} — код запису в Barber\. Дійсний 10 хв\.$/);
  });

  it('a wrong SMS code is refused; at most 3 codes per hold', async () => {
    const hold = await newHold();
    await sendCode(hold, { codeChannel: 'sms' }).expect(202);
    const wrong = smsCode() === '000000' ? '111111' : '000000';
    const bad = await ctx
      .http()
      .post(`/v1/public/holds/${hold.holdId}/confirm`)
      .send({ holdToken: hold.holdToken, code: wrong })
      .expect(400);
    expectError(bad.body, 'INVALID_CODE');
    await sendCode(hold, { codeChannel: 'sms' }).expect(202);
    await sendCode(hold, { codeChannel: 'sms' }).expect(202);
    const fourth = await sendCode(hold, { codeChannel: 'sms' }).expect(429);
    expectError(fourth.body, 'TOO_MANY_CODES');
    expect(ctx.sms.sent).toHaveLength(3);
  });

  it('at most 5 SMS per phone number an hour, across holds', async () => {
    for (const hh of [9, 10, 11, 12, 13]) {
      await sendCode(await newHold(hh), { codeChannel: 'sms' }).expect(202);
    }
    const res = await sendCode(await newHold(14), { codeChannel: 'sms' }).expect(429);
    expectError(res.body, 'RATE_LIMITED');
    expect(ctx.sms.sent).toHaveLength(5);
  });

  it('an email confirmed only by SMS does not rewrite the salon card of that address', async () => {
    const card = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/customers`)
      .set(owner.auth)
      .send({ name: 'Anna Prawdziwa', phone: '+48500500500', email: EMAIL })
      .expect(201);

    const hold = await newHold();
    await sendCode(hold, { codeChannel: 'sms', name: 'Ktoś Inny' }).expect(202);
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.holdId}/confirm`)
      .send({ holdToken: hold.holdToken, code: smsCode() })
      .expect(200);

    const after = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: card.body.id } });
    expect(after.name).toBe('Anna Prawdziwa');
    expect(after.phone).toBe('+48500500500');
  });

  it('without a gateway SMS is not offered and is refused', async () => {
    ctx.sms.available = false;
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.codeChannels).toEqual(['email']);
    const res = await sendCode(await newHold(), { codeChannel: 'sms' }).expect(400);
    expectError(res.body, 'SMS_UNAVAILABLE');
  });

  it('rejects an unknown channel', async () => {
    const res = await sendCode(await newHold(), { codeChannel: 'pigeon' }).expect(400);
    expectError(res.body, 'VALIDATION_ERROR');
  });
});
