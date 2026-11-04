import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createTestApp,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Launch task L5: a salon outside Poland. Its working hours, free times, visits, the calendar,
 * "changes possible until" and the emails are in the salon's time zone — not the server's and
 * not Warsaw. Istanbul is UTC+3 all year: 10:00 there is 07:00 UTC and 08:00 or 09:00 in Warsaw.
 */
const TZ = 'Europe/Istanbul';
const CLIENT = {
  name: 'Ayşe Yılmaz',
  phone: '+905321002000',
  email: 'ayse.tz@example.com',
  locale: 'en',
  acceptTerms: true,
};

let ctx: TestContext;
let outbox: OutboxService;
let owner: SignedInUser;
let base: string;
let slug: string;
let serviceId: string;
let staffId: string;
let day: string;

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
  const org = await ctx
    .http()
    .post('/v1/organizations')
    .set(owner.auth)
    .send({ name: 'Berber Kadıköy' })
    .expect(201);
  const location = await ctx
    .http()
    .post(`/v1/organizations/${org.body.id}/locations`)
    .set(owner.auth)
    .send({
      name: 'Berber Kadıköy',
      addressLine: 'Moda Cd. 1',
      city: 'İstanbul',
      postalCode: '34710',
      timezone: TZ,
      currency: 'TRY',
      clientCancelDeadlineMinutes: 180,
      onlineBookingEnabled: true,
      ...LEGAL_TEXTS,
    })
    .expect(201);
  slug = location.body.slug;
  base = `/v1/organizations/${org.body.id}/locations/${location.body.id}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Saç kesimi', durationMinutes: 60, priceGrosze: 50000 })
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
        intervals: [{ start: '10:00', end: '12:00' }],
      })),
    })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

describe('a salon in another time zone', () => {
  it('offers free times, books and shows the visit in the salon’s local time', async () => {
    const availability = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/availability`)
      .query({ serviceId, staffId, from: day, to: day })
      .expect(200);
    expect(availability.body.timezone).toBe(TZ);
    const times = availability.body.slots.map((s: { time: string }) => s.time);
    expect(times[0]).toBe('10:00');
    expect(times.at(-1)).toBe('11:00');
    const first = availability.body.slots[0];
    // 10:00 in Istanbul is 07:00 UTC.
    expect(first.start).toBe(new Date(zonedToInstant(day, 10 * 60, TZ)).toISOString());
    expect(new Date(first.start).getUTCHours()).toBe(7);

    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start: first.start })
      .expect(201);
    expect(hold.body).toMatchObject({ date: day, time: '10:00', currency: 'TRY' });
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
    const appointment = confirmed.body.appointment;
    expect(appointment).toMatchObject({ date: day, time: '10:00', timezone: TZ });
    // Changes online until 3 hours before: 07:00 Istanbul = 04:00 UTC.
    expect(appointment.changeableUntil).toBe(
      new Date(zonedToInstant(day, 7 * 60, TZ)).toISOString(),
    );

    // The salon's calendar of that local day holds the visit at 10:00 local time.
    const calendar = await ctx
      .http()
      .get(`${base}/calendar`)
      .query({ from: day, to: day })
      .set(owner.auth)
      .expect(200);
    expect(calendar.body.location.timezone).toBe(TZ);
    expect(calendar.body.appointments.map((v: { start: string }) => v.start)).toEqual([
      first.start,
    ]);

    // The email says 10:00, not the server's or Warsaw's hour.
    await outbox.drain();
    const confirmation = ctx.mail
      .allTo(CLIENT.email)
      .find((m) => m.text.includes('10:00') && m.text.includes('TRY'));
    expect(
      confirmation,
      'confirmation at 10:00 Istanbul time with the price in lira',
    ).toBeDefined();
    expect(confirmation!.text).not.toMatch(/\b0[789]:00\b/);
  });
});
