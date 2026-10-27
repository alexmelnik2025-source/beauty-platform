import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, isoWeekday, localToday } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let base: string;
let orgId: string;
let locationId: string;

/** A fixed future Monday: far from "now", so lead time never interferes. */
const MONDAY = '2027-01-04';

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
  orgId = org.orgId;
  locationId = org.locationId;
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
});

const haircut = {
  name: 'Strzyżenie męskie',
  durationMinutes: 45,
  bufferMinutes: 15,
  priceGrosze: 8000,
};

async function setupStaff(
  hours: { weekday: number; intervals: { start: string; end: string }[] }[],
) {
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send(haircut)
    .expect(201);
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
    .expect(201);
  await ctx
    .http()
    .put(`${base}/staff/${staff.body.id}/working-hours`)
    .set(owner.auth)
    .send({ days: hours })
    .expect(200);
  return { serviceId: service.body.id as string, staffId: staff.body.id as string };
}

const availability = (serviceId: string, from: string, to = from, staffId?: string) =>
  ctx
    .http()
    .get(`${base}/availability`)
    .query({ serviceId, from, to, ...(staffId ? { staffId } : {}) })
    .set(owner.auth);

describe('services', () => {
  it('creates, lists and updates with optimistic locking', async () => {
    const created = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send(haircut)
      .expect(201);
    expect(created.body).toMatchObject({ ...haircut, active: true, version: 1 });

    const updated = await ctx
      .http()
      .patch(`${base}/services/${created.body.id}`)
      .set(owner.auth)
      .send({ version: 1, priceGrosze: 9000 })
      .expect(200);
    expect(updated.body).toMatchObject({ priceGrosze: 9000, version: 2 });

    const stale = await ctx
      .http()
      .patch(`${base}/services/${created.body.id}`)
      .set(owner.auth)
      .send({ version: 1, priceGrosze: 1 })
      .expect(409);
    expectError(stale.body, 'VERSION_CONFLICT');

    const list = await ctx.http().get(`${base}/services`).set(owner.auth).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('rejects durations that are not in 5-minute steps and negative prices', async () => {
    const res = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'X', durationMinutes: 42, priceGrosze: -1 })
      .expect(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['durationMinutes', 'priceGrosze']));
  });
});

describe('staff and working hours', () => {
  it('stores weekly hours with breaks and returns them in local time', async () => {
    const { staffId } = await setupStaff([
      {
        weekday: 1,
        intervals: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    ]);
    const res = await ctx
      .http()
      .get(`${base}/staff/${staffId}/working-hours`)
      .set(owner.auth)
      .expect(200);
    expect(res.body).toMatchObject({
      timezone: 'Europe/Warsaw',
      weekly: [
        {
          weekday: 1,
          intervals: [
            { start: '09:00', end: '13:00' },
            { start: '14:00', end: '18:00' },
          ],
        },
      ],
    });
  });

  it('rejects overlapping intervals and end before start', async () => {
    const { staffId } = await setupStaff([]);
    await ctx
      .http()
      .put(`${base}/staff/${staffId}/working-hours`)
      .set(owner.auth)
      .send({
        days: [
          {
            weekday: 1,
            intervals: [
              { start: '09:00', end: '13:00' },
              { start: '12:00', end: '15:00' },
            ],
          },
        ],
      })
      .expect(400);
    await ctx
      .http()
      .put(`${base}/staff/${staffId}/working-hours`)
      .set(owner.auth)
      .send({ days: [{ weekday: 1, intervals: [{ start: '18:00', end: '09:00' }] }] })
      .expect(400);
  });

  it('replaces the services a staff member performs', async () => {
    const { staffId } = await setupStaff([]);
    const beard = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Broda', durationMinutes: 30, priceGrosze: 5000 })
      .expect(201);
    const res = await ctx
      .http()
      .put(`${base}/staff/${staffId}/services`)
      .set(owner.auth)
      .send({ serviceIds: [beard.body.id] })
      .expect(200);
    expect(res.body.serviceIds).toEqual([beard.body.id]);
  });
});

describe('availability', () => {
  it('computes slots from hours, breaks, service length and buffer', async () => {
    const { serviceId } = await setupStaff([
      {
        weekday: 1,
        intervals: [
          { start: '09:00', end: '11:00' },
          { start: '12:00', end: '13:00' },
        ],
      },
    ]);
    const res = await availability(serviceId, MONDAY).expect(200);
    expect(res.body.timezone).toBe('Europe/Warsaw');
    // 45 min + 15 min buffer, 15 min step: 09:00–11:00 gives 09:00…10:00; 12:00–13:00 gives 12:00.
    expect(res.body.slots.map((s: { time: string }) => s.time)).toEqual([
      '09:00',
      '09:15',
      '09:30',
      '09:45',
      '10:00',
      '12:00',
    ]);
    expect(res.body.slots[0].start).toBe('2027-01-04T08:00:00.000Z');
  });

  it('time off removes slots; special hours replace the weekly hours', async () => {
    const { serviceId, staffId } = await setupStaff([
      { weekday: 1, intervals: [{ start: '09:00', end: '12:00' }] },
    ]);
    await ctx
      .http()
      .post(`${base}/staff/${staffId}/time-off`)
      .set(owner.auth)
      .send({ start: `${MONDAY}T09:00`, end: `${MONDAY}T10:00`, note: 'Lekarz' })
      .expect(201);
    let times = (await availability(serviceId, MONDAY)).body.slots.map(
      (s: { time: string }) => s.time,
    );
    expect(times[0]).toBe('10:00');

    const nextMonday = addDays(MONDAY, 7);
    await ctx
      .http()
      .put(`${base}/staff/${staffId}/working-hours/overrides/${nextMonday}`)
      .set(owner.auth)
      .send({ intervals: [{ start: '16:00', end: '17:00' }] })
      .expect(200);
    times = (await availability(serviceId, nextMonday)).body.slots.map(
      (s: { time: string }) => s.time,
    );
    expect(times).toEqual(['16:00']);

    await ctx
      .http()
      .delete(`${base}/staff/${staffId}/working-hours/overrides/${nextMonday}`)
      .set(owner.auth)
      .expect(204);
    times = (await availability(serviceId, nextMonday)).body.slots.map(
      (s: { time: string }) => s.time,
    );
    expect(times[0]).toBe('09:00');
  });

  it('a deactivated staff member or service has no availability', async () => {
    const { serviceId, staffId } = await setupStaff([
      { weekday: 1, intervals: [{ start: '09:00', end: '12:00' }] },
    ]);
    await ctx
      .http()
      .patch(`${base}/staff/${staffId}`)
      .set(owner.auth)
      .send({ version: 1, active: false })
      .expect(200);
    expect((await availability(serviceId, MONDAY)).body.slots).toEqual([]);

    await ctx
      .http()
      .patch(`${base}/services/${serviceId}`)
      .set(owner.auth)
      .send({ version: 1, active: false })
      .expect(200);
    await availability(serviceId, MONDAY).expect(404);
  });

  it('rejects ranges longer than 31 days and a staff member who does not offer the service', async () => {
    const { serviceId } = await setupStaff([]);
    const long = await availability(serviceId, MONDAY, addDays(MONDAY, 31)).expect(400);
    expectError(long.body, 'VALIDATION_ERROR');
    const other = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Ola' })
      .expect(201);
    const mismatch = await availability(serviceId, MONDAY, MONDAY, other.body.id).expect(400);
    expectError(mismatch.body, 'STAFF_SERVICE_MISMATCH');
  });
});

describe('public booking page', () => {
  async function enableBooking(extra: Record<string, unknown> = {}) {
    const current = await ctx.http().get(base).set(owner.auth).expect(200);
    return ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: current.body.version, onlineBookingEnabled: true, ...extra })
      .expect(200);
  }

  it('is hidden until online booking is switched on', async () => {
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx.http().get(`/v1/public/locations/${loc.body.slug}`).expect(404);
    await enableBooking();
    await ctx.http().get(`/v1/public/locations/${loc.body.slug}`).expect(200);
  });

  it('shows only bookable services and never internal details', async () => {
    const { serviceId } = await setupStaff([
      { weekday: 1, intervals: [{ start: '09:00', end: '17:00' }] },
    ]);
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Nobody does this', durationMinutes: 30, priceGrosze: 100 })
      .expect(201);
    const { body: loc } = await enableBooking();

    const res = await ctx.http().get(`/v1/public/locations/${loc.slug}`).expect(200);
    expect(res.body.services.map((s: { id: string }) => s.id)).toEqual([serviceId]);
    expect(res.body.services[0]).not.toHaveProperty('bufferMinutes');
    expect(res.body.staff[0]).toEqual({
      id: expect.any(String),
      displayName: 'Kasia',
      bio: null,
      languages: [],
      serviceIds: [serviceId],
    });
    expect(res.body).not.toHaveProperty('organizationId');
  });

  it('applies the booking horizon and minimum lead time', async () => {
    const today = localToday(Date.now(), 'Europe/Warsaw');
    const allDays = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      intervals: [{ start: '00:00', end: '24:00' }],
    }));
    const { serviceId } = await setupStaff(allDays);
    const { body: loc } = await enableBooking({ bookingHorizonDays: 7, minLeadMinutes: 24 * 60 });
    const get = (from: string, to: string) =>
      ctx
        .http()
        .get(`/v1/public/locations/${loc.slug}/availability`)
        .query({ serviceId, from, to })
        .expect(200);

    // Beyond the 7-day horizon: nothing.
    expect((await get(addDays(today, 9), addDays(today, 10))).body.slots).toEqual([]);
    // Today: nothing, because of the 24-hour minimum lead time.
    expect((await get(today, today)).body.slots).toEqual([]);
    // In 3 days: available all day.
    const inThreeDays = addDays(today, 3);
    const slots = (await get(inThreeDays, inThreeDays)).body.slots;
    expect(slots.length).toBeGreaterThan(10);
    expect(isoWeekday(inThreeDays)).toBeGreaterThan(0);
  });
});

describe('spoken languages', () => {
  const enable = async (extra: Record<string, unknown>) => {
    const current = await ctx.http().get(base).set(owner.auth).expect(200);
    return ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: current.body.version, ...extra });
  };

  it('the salon and each staff member keep their languages; the booking page shows them', async () => {
    const { staffId } = await setupStaff([
      { weekday: 1, intervals: [{ start: '09:00', end: '17:00' }] },
    ]);
    const loc = await enable({ onlineBookingEnabled: true, languages: ['pl', 'uk', 'ru', 'uk'] });
    expect(loc.status).toBe(200);
    // Repeats are dropped, the salon's order is kept.
    expect(loc.body.languages).toEqual(['pl', 'uk', 'ru']);

    const staff = await ctx.http().get(`${base}/staff/${staffId}`).set(owner.auth).expect(200);
    expect(staff.body.languages).toEqual([]);
    const updated = await ctx
      .http()
      .patch(`${base}/staff/${staffId}`)
      .set(owner.auth)
      .send({ version: staff.body.version, languages: ['be', 'ru', 'pl'] })
      .expect(200);
    expect(updated.body.languages).toEqual(['be', 'ru', 'pl']);

    const created = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Oksana', languages: ['uk', 'en'] })
      .expect(201);
    expect(created.body.languages).toEqual(['uk', 'en']);

    const page = await ctx.http().get(`/v1/public/locations/${loc.body.slug}`).expect(200);
    expect(page.body.languages).toEqual(['pl', 'uk', 'ru']);
    expect(page.body.staff).toEqual([
      expect.objectContaining({ id: staffId, languages: ['be', 'ru', 'pl'] }),
    ]);

    // An empty list clears them.
    const cleared = await enable({ languages: [] });
    expect(cleared.body.languages).toEqual([]);
  });

  it('rejects unknown languages', async () => {
    const res = await enable({ languages: ['pl', 'de'] });
    expect(res.status).toBe(400);
    expectError(res.body, 'VALIDATION_ERROR');
    const bad = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'X', languages: 'pl' })
      .expect(400);
    expectError(bad.body, 'VALIDATION_ERROR');
  });

  it('staff cannot change the salon languages', async () => {
    const member = await signUp(ctx, 'staff@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: member.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    const current = await ctx.http().get(base).set(member.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(member.auth)
      .send({ version: current.body.version, languages: ['en'] })
      .expect(403);
  });
});

describe('salon profile on the booking page', () => {
  const patch = async (extra: Record<string, unknown>, auth = owner.auth) => {
    const current = await ctx.http().get(base).set(auth).expect(200);
    return ctx
      .http()
      .patch(base)
      .set(auth)
      .send({ version: current.body.version, ...extra });
  };

  it('keeps the description; an empty text removes it', async () => {
    const res = await patch({
      onlineBookingEnabled: true,
      description: '  Barbershop na Mokotowie. Kawa gratis.  ',
    });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('Barbershop na Mokotowie. Kawa gratis.');
    const page = await ctx.http().get(`/v1/public/locations/${res.body.slug}`).expect(200);
    expect(page.body.description).toBe('Barbershop na Mokotowie. Kawa gratis.');

    const cleared = await patch({ description: '   ' });
    expect(cleared.body.description).toBeNull();
    const again = await ctx.http().get(`/v1/public/locations/${res.body.slug}`).expect(200);
    expect(again.body.description).toBeNull();
  });

  it('rejects a description longer than 1000 characters', async () => {
    const res = await patch({ description: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
    expectError(res.body, 'VALIDATION_ERROR');
  });

  it('staff cannot change the description', async () => {
    const member = await signUp(ctx, 'staff@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: member.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    const res = await patch({ description: 'Hacked' }, member.auth);
    expect(res.status).toBe(403);
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(loc.body.description).toBeNull();
  });

  it('opening hours merge the weekly hours of everyone who takes bookings', async () => {
    const { serviceId } = await setupStaff([
      {
        weekday: 1,
        intervals: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '17:00' },
        ],
      },
      { weekday: 6, intervals: [{ start: '10:00', end: '14:00' }] },
    ]);
    const second = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Ola', serviceIds: [serviceId] })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${second.body.id}/working-hours`)
      .set(owner.auth)
      .send({
        days: [
          {
            weekday: 1,
            intervals: [
              { start: '12:00', end: '14:00' },
              { start: '18:00', end: '20:00' },
            ],
          },
          { weekday: 2, intervals: [{ start: '08:00', end: '16:00' }] },
        ],
      })
      .expect(200);
    // Not shown to clients (no services), so their hours do not count.
    const hidden = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Admin' })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${hidden.body.id}/working-hours`)
      .set(owner.auth)
      .send({ days: [{ weekday: 7, intervals: [{ start: '10:00', end: '12:00' }] }] })
      .expect(200);

    const { body: loc } = await patch({ onlineBookingEnabled: true });
    const page = await ctx.http().get(`/v1/public/locations/${loc.slug}`).expect(200);
    expect(page.body.openingHours).toEqual([
      {
        weekday: 1,
        intervals: [
          { start: '09:00', end: '17:00' },
          { start: '18:00', end: '20:00' },
        ],
      },
      { weekday: 2, intervals: [{ start: '08:00', end: '16:00' }] },
      { weekday: 3, intervals: [] },
      { weekday: 4, intervals: [] },
      { weekday: 5, intervals: [] },
      { weekday: 6, intervals: [{ start: '10:00', end: '14:00' }] },
      { weekday: 7, intervals: [] },
    ]);
  });

  it('a salon without a team shows every day closed', async () => {
    const { body: loc } = await patch({ onlineBookingEnabled: true });
    const page = await ctx.http().get(`/v1/public/locations/${loc.slug}`).expect(200);
    expect(page.body.openingHours).toHaveLength(7);
    expect(
      page.body.openingHours.every((d: { intervals: unknown[] }) => d.intervals.length === 0),
    ).toBe(true);
    expect(page.body.description).toBeNull();
  });
});

describe('permissions', () => {
  it('staff can read the schedule but not change it', async () => {
    const { serviceId, staffId } = await setupStaff([
      { weekday: 1, intervals: [{ start: '09:00', end: '12:00' }] },
    ]);
    const member = await signUp(ctx, 'staff@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: member.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.http().get(`${base}/staff/${staffId}/working-hours`).set(member.auth).expect(200);
    await availability(serviceId, MONDAY).set(member.auth).expect(200);
    const res = await ctx
      .http()
      .post(`${base}/services`)
      .set(member.auth)
      .send({ name: 'X', durationMinutes: 30, priceGrosze: 100 })
      .expect(403);
    expectError(res.body, 'FORBIDDEN');
    await ctx
      .http()
      .post(`${base}/staff/${staffId}/time-off`)
      .set(member.auth)
      .send({ start: `${MONDAY}T09:00`, end: `${MONDAY}T10:00` })
      .expect(403);
  });

  it('a manager of another location cannot see this one', async () => {
    const other = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({ name: 'Wola', addressLine: 'ul. Wolska 1', city: 'Warszawa', postalCode: '01-001' })
      .expect(201);
    const manager = await signUp(ctx, 'manager@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: manager.userId,
        organizationId: orgId,
        role: 'manager',
        locations: { create: [{ locationId: other.body.id }] },
      },
    });
    await ctx.http().get(`${base}/services`).set(manager.auth).expect(404);
    await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations/${other.body.id}/services`)
      .set(manager.auth)
      .send(haircut)
      .expect(201);
  });
});

describe('database integrity rules', () => {
  it('the database itself rejects impossible working hours and time off', async () => {
    const { staffId } = await setupStaff([]);
    await expect(
      ctx.prisma.workingHours.create({
        data: { staffId, weekday: 1, startMinute: 600, endMinute: 540 },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.workingHours.create({
        data: { staffId, weekday: 8, startMinute: 540, endMinute: 600 },
      }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.timeOff.create({
        data: {
          staffId,
          startsAt: new Date('2027-01-04T10:00Z'),
          endsAt: new Date('2027-01-04T09:00Z'),
        },
      }),
    ).rejects.toThrow();
  });
});
