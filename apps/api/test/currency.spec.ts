import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { formatMoney } from '../src/common/currency';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LEGAL_TEXTS,
  LOCATION,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Launch task L5, part 1: every location prices its services in its own currency. */
const TZ = 'Europe/Warsaw';
const CLIENT = {
  name: 'Ayşe Yılmaz',
  phone: '+90 532 100 2000',
  email: 'ayse.client@example.com',
  locale: 'en',
  acceptTerms: true,
};

let ctx: TestContext;
let outbox: OutboxService;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let serviceId: string;
let staffId: string;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(OutboxService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Berber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Haircut', durationMinutes: 30, priceGrosze: 45050 })
    .expect(201);
  serviceId = service.body.id;
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Emre', serviceIds: [serviceId] })
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
});

async function setCurrency(currency: string, status: number) {
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  return ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, currency, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(status);
}

describe('currency of a location', () => {
  it('is PLN unless the salon chooses another one', async () => {
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(loc.body.currency).toBe('PLN');

    const created = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({ ...LOCATION, name: 'Tirana', currency: 'ALL', timezone: 'Europe/Tirane' })
      .expect(201);
    expect(created.body).toMatchObject({ currency: 'ALL', timezone: 'Europe/Tirane' });
  });

  it('accepts only supported ISO codes', async () => {
    for (const wrong of ['XYZ', 'eur', 'EURO', '']) {
      const res = await setCurrency(wrong, 400);
      expectError(res.body, 'VALIDATION_ERROR');
    }
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(loc.body.currency).toBe('PLN');
  });

  it('is shown with the prices on the booking page, in the booking steps, calendar and emails', async () => {
    const saved = await setCurrency('EUR', 200);
    expect(saved.body.currency).toBe('EUR');

    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.currency).toBe('EUR');

    const day = addDays(localToday(Date.now(), TZ), 3);
    const start = new Date(zonedToInstant(day, 10 * 60, TZ)).toISOString();
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start })
      .expect(201);
    expect(hold.body).toMatchObject({ priceGrosze: 45050, currency: 'EUR' });

    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({ holdToken: hold.body.holdToken, ...CLIENT })
      .expect(202);
    const code = ctx.mail.lastTo(CLIENT.email)!.text.match(/\b(\d{6})\b/)![1];
    const confirmed = await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
      .send({ holdToken: hold.body.holdToken, code })
      .expect(200);
    expect(confirmed.body.appointment).toMatchObject({
      currency: 'EUR',
      service: { priceGrosze: 45050 },
    });

    const calendar = await ctx
      .http()
      .get(`${base}/calendar`)
      .query({ from: day, to: day })
      .set(owner.auth)
      .expect(200);
    expect(calendar.body.location.currency).toBe('EUR');

    // The confirmation email shows the price in euro, written the way the client's language does.
    await outbox.drain();
    const email = ctx.mail
      .allTo(CLIENT.email)
      .find((m) => m.text.includes(formatMoney(45050, 'EUR', 'en-GB')));
    expect(email, 'confirmation with the price in euro').toBeDefined();
    expect(email!.text).toContain('€450.50');
    expect(email!.text).not.toContain('zł');
  });

  it('formats amounts in hundredths of any supported currency', () => {
    const plain = (s: string) => s.replace(/\s/g, ' ');
    expect(plain(formatMoney(4500, 'PLN', 'pl-PL'))).toBe('45,00 zł');
    expect(formatMoney(4500, 'EUR', 'en-GB')).toBe('€45.00');
    expect(formatMoney(50000, 'TRY', 'en-GB')).toContain('500.00');
    expect(formatMoney(4500, 'UAH', 'uk-UA')).toContain('45,00');
  });
});
