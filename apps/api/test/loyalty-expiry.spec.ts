import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { LoyaltyExpiryService } from '../src/loyalty/loyalty-expiry.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 10f, part 1: points past their date leave the balance, the earliest first. */

const TZ = 'Europe/Warsaw';
const DAY_MS = 86_400_000;

let ctx: TestContext;
let expiry: LoyaltyExpiryService;
let owner: SignedInUser;
let orgId: string;
let base: string;
let haircutId: string;
let staffId: string;
let hour = 8;

const POINTS = {
  enabled: true,
  mode: 'points',
  stampsPerVisit: 1,
  pointsPerUnit: 10,
  spendUnitGrosze: 10_000,
  minSpendGrosze: 0,
  pointsValidityDays: 30,
  maxDiscountPercent: 100,
  allowStacking: false,
  marketplaceEnabled: false,
} as const;

beforeAll(async () => {
  ctx = await createTestApp();
  expiry = ctx.app.get(LoyaltyExpiryService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  hour = 8;
  owner = await signUp(ctx, 'owner@example.com');
  const created = await createOrgWithLocation(ctx, owner, 'Barber');
  orgId = created.orgId;
  base = `/v1/organizations/${orgId}/locations/${created.locationId}`;
  haircutId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  staffId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [haircutId] })
      .expect(201)
  ).body.id;
  await saveProgram({});
});

const loyalty = () => `/v1/organizations/${orgId}/loyalty`;

async function saveProgram(changes: object): Promise<void> {
  const current = await ctx.http().get(`${loyalty()}/program`).set(owner.auth).expect(200);
  await ctx
    .http()
    .put(`${loyalty()}/program`)
    .set(owner.auth)
    .send({ ...POINTS, ...changes, version: current.body.version })
    .expect(200);
}

/** A client card (from a booked visit). */
async function client(email = 'jan@example.com'): Promise<string> {
  const day = addDays(localToday(Date.now(), TZ), 2);
  const start = new Date(zonedToInstant(day, hour++ * 60, TZ));
  const res = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId,
      start: start.toISOString(),
      allowOutsideHours: true,
      customer: { name: 'Jan Nowak', phone: '+48600000002', email },
    })
    .expect(201);
  return res.body.customer.id;
}

const add = (customerId: string, points: number) =>
  ctx
    .http()
    .post(`${loyalty()}/accounts/${customerId}/adjustments`)
    .set(owner.auth)
    .send({ points, reason: 'Karta papierowa' })
    .expect(201);

async function spend(customerId: string, cost: number): Promise<string> {
  const reward = await ctx
    .http()
    .post(`${loyalty()}/rewards`)
    .set(owner.auth)
    .send({ name: `Rabat ${cost}`, kind: 'discount_percent', discountPercent: 10, cost })
    .expect(201);
  const coupon = await ctx
    .http()
    .post(`${loyalty()}/accounts/${customerId}/redemptions`)
    .set(owner.auth)
    .send({ rewardId: reward.body.id })
    .expect(201);
  return coupon.body.id;
}

const account = async (customerId: string) =>
  (await ctx.http().get(`${loyalty()}/accounts/${customerId}`).set(owner.auth).expect(200)).body;

const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);

describe('points past their date', () => {
  it('leave the balance once, after what was spent', async () => {
    const jan = await client();
    await add(jan, 50);
    await add(jan, 30);
    await spend(jan, 40);

    expect(await expiry.run(inDays(29))).toMatchObject({ accounts: 0, points: 0 });
    expect(await expiry.run(inDays(31))).toMatchObject({ accounts: 1, points: 40 });
    // Running again (or on another server) takes nothing more.
    expect(await expiry.run(inDays(31))).toMatchObject({ accounts: 0, points: 0 });

    const acc = await account(jan);
    expect(acc.balance).toBe(0);
    expect(acc.transactions[0]).toMatchObject({ type: 'expire', points: -40, balanceAfter: 0 });
  });

  it('the earliest points go first; later ones wait for their own date', async () => {
    const jan = await client();
    await add(jan, 50); // expires in 30 days
    await saveProgram({ pointsValidityDays: 60 });
    await add(jan, 30); // expires in 60 days
    await spend(jan, 20); // taken from the 50 that expire first

    expect(await expiry.run(inDays(31))).toMatchObject({ accounts: 1, points: 30 });
    expect((await account(jan)).balance).toBe(30);
    expect(await expiry.run(inDays(61))).toMatchObject({ accounts: 1, points: 30 });
    expect((await account(jan)).balance).toBe(0);
  });

  it('a cancelled coupon gives its points back; they can still expire', async () => {
    const jan = await client();
    await add(jan, 50);
    const coupon = await spend(jan, 40);
    await ctx
      .http()
      .post(`${loyalty()}/coupons/${coupon}/cancel`)
      .set(owner.auth)
      .send({ version: 1 })
      .expect(200);
    expect(await expiry.run(inDays(31))).toMatchObject({ accounts: 1, points: 50 });
  });

  it('points without a date and other clients are left alone', async () => {
    const jan = await client();
    const ewa = await client('ewa@example.com');
    await add(jan, 20);
    await saveProgram({ pointsValidityDays: null });
    await add(ewa, 20);
    expect(await expiry.run(inDays(400))).toMatchObject({ accounts: 1, points: 20 });
    expect((await account(jan)).balance).toBe(0);
    expect((await account(ewa)).balance).toBe(20);
  });

  it('the client sees the expiry in "Moje bonusy" history', async () => {
    const jan = await client();
    await add(jan, 20);
    await expiry.run(inDays(31));
    await ctx.http().post('/v1/client/auth/code').send({ email: 'jan@example.com' }).expect(202);
    const code = ctx.mail.lastTo('jan@example.com')!.text.match(/\b(\d{6})\b/)![1];
    const session = await ctx
      .http()
      .post('/v1/client/auth/verify')
      .send({ email: 'jan@example.com', code, clientType: 'mobile' })
      .expect(200);
    const mine = await ctx
      .http()
      .get('/v1/client/loyalty')
      .set({ Authorization: `Bearer ${session.body.token}` })
      .expect(200);
    expect(mine.body.items[0].balance).toBe(0);
    expect(mine.body.items[0].history[0]).toMatchObject({ type: 'expire', points: -20 });
  });

  it('a week before, the client gets one email from the salon', async () => {
    const jan = await client();
    await add(jan, 50);
    await spend(jan, 20);
    expect((await expiry.run(inDays(20))).warned).toBe(0);
    expect((await expiry.run(inDays(24))).warned).toBe(1);
    // Once for each date, however often the job runs.
    expect((await expiry.run(inDays(25))).warned).toBe(0);
    await ctx.app.get(OutboxService).drain();
    const mail = ctx.mail.lastTo('jan@example.com');
    expect(mail?.subject).toBe('Twoje punkty wkrótce wygasną');
    expect(mail?.text).toContain('W Barber Centrum masz punkty, które wygasną');
    expect(mail?.text).toContain(': 30 pkt.');
  });

  it('no email when the program is off or the points were spent', async () => {
    const jan = await client();
    await add(jan, 20);
    await spend(jan, 20);
    expect((await expiry.run(inDays(24))).warned).toBe(0);
    const ewa = await client('ewa@example.com');
    await add(ewa, 20);
    await saveProgram({ enabled: false });
    expect((await expiry.run(inDays(24))).warned).toBe(0);
  });
});
