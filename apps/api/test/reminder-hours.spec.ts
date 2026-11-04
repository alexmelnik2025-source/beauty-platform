import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 22: the salon chooses how many hours before the visit the reminder goes (0 = none). */

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let location: string;
let base: string;
let serviceId: string;
let staffId: string;
let hour = 9;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  hour = 9;
  owner = await signUp(ctx, 'owner@example.com');
  const created = await createOrgWithLocation(ctx, owner, 'Barber');
  location = `/v1/organizations/${created.orgId}/locations/${created.locationId}`;
  base = location;
  serviceId = (
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
      .send({ displayName: 'Kasia', serviceIds: [serviceId] })
      .expect(201)
  ).body.id;
});

async function setReminder(hours: number, expected = 200) {
  const current = await ctx.http().get(location).set(owner.auth).expect(200);
  return ctx
    .http()
    .patch(location)
    .set(owner.auth)
    .send({ version: current.body.version, reminderHoursBefore: hours })
    .expect(expected);
}

/** Books a visit 3 days ahead from the cabinet; returns its start and the queued reminder. */
async function book(): Promise<{ start: number; reminder: Date | null }> {
  const start = zonedToInstant(addDays(localToday(Date.now(), TZ), 3), hour++ * 60, TZ);
  const booked = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId,
      staffId,
      start: new Date(start).toISOString(),
      allowOutsideHours: true,
      customer: { name: 'Jan Nowak', phone: '+48600000002', email: 'jan@example.com' },
    })
    .expect(201);
  const row = await ctx.prisma.notificationOutbox.findFirst({
    where: {
      type: 'client_reminder',
      payload: { path: ['appointmentId'], equals: booked.body.id },
    },
  });
  return { start, reminder: row?.nextAttemptAt ?? null };
}

describe('reminder before the visit', () => {
  it('24 hours by default, as many hours as the salon chose, or none', async () => {
    const created = await ctx.http().get(location).set(owner.auth).expect(200);
    expect(created.body.reminderHoursBefore).toBe(24);
    const daily = await book();
    expect(daily.reminder?.getTime()).toBe(daily.start - 24 * 3_600_000);

    const saved = await setReminder(2);
    expect(saved.body.reminderHoursBefore).toBe(2);
    const short = await book();
    expect(short.reminder?.getTime()).toBe(short.start - 2 * 3_600_000);

    await setReminder(0);
    expect((await book()).reminder).toBeNull();
  });

  it('only the listed values', async () => {
    await setReminder(5, 400);
    await setReminder(-1, 400);
    await setReminder(72, 400);
    await setReminder(48);
  });

  it('a visit too soon for the reminder gets none', async () => {
    await setReminder(48);
    const day = addDays(localToday(Date.now(), TZ), 1);
    const start = zonedToInstant(day, 23 * 60, TZ);
    // Tomorrow is always less than 48 hours away.
    expect(start - Date.now()).toBeLessThan(48 * 3_600_000);
    const booked = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId,
        staffId,
        start: new Date(start).toISOString(),
        allowOutsideHours: true,
        customer: { name: 'Jan Nowak', phone: '+48600000002', email: 'jan@example.com' },
      })
      .expect(201);
    const queued = await ctx.prisma.notificationOutbox.count({
      where: {
        type: 'client_reminder',
        payload: { path: ['appointmentId'], equals: booked.body.id },
      },
    });
    expect(queued).toBe(0);
  });
});
