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

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let serviceId: string;
let kasiaId: string;
let olaId: string;
let day: string;

const at = (hh: number, date = day): string =>
  new Date(zonedToInstant(date, hh * 60, TZ)).toISOString();

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
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  const ids: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [serviceId] })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${staff.body.id}/working-hours`)
      .set(owner.auth)
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [
            { start: '09:00', end: '13:00' },
            { start: '14:00', end: '18:00' },
          ],
        })),
      })
      .expect(200);
    ids.push(staff.body.id);
  }
  [kasiaId, olaId] = ids as [string, string];
  day = addDays(localToday(Date.now(), TZ), 3);
});

const calendar = (auth = owner.auth, from = day, to = day) =>
  ctx.http().get(`${base}/calendar`).query({ from, to }).set(auth);

describe('calendar in one request', () => {
  it('returns hours per day (special days applied), time off, appointments and blocks', async () => {
    const next = addDays(day, 1);
    await ctx
      .http()
      .put(`${base}/staff/${olaId}/working-hours/overrides/${next}`)
      .set(owner.auth)
      .send({ intervals: [{ start: '10:00', end: '12:00' }] })
      .expect(200);
    await ctx
      .http()
      .post(`${base}/staff/${olaId}/time-off`)
      .set(owner.auth)
      .send({ start: `${day}T16:00`, end: `${day}T18:00`, note: 'Lekarz' })
      .expect(201);
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId,
        staffId: kasiaId,
        start: at(10),
        customer: { name: 'Jan', phone: '+48600000001' },
      })
      .expect(201);
    await ctx
      .http()
      .post(`${base}/time-blocks`)
      .set(owner.auth)
      .send({ staffId: null, start: at(12), end: at(13), reason: 'Zebranie' })
      .expect(201);

    const res = await calendar(owner.auth, day, next).expect(200);
    expect(res.headers.etag).toMatch(/^".+"$/);
    expect(res.body.location).toMatchObject({ timezone: TZ, slotStepMinutes: 15 });
    expect(res.body.staff.map((s: { displayName: string }) => s.displayName)).toEqual([
      'Kasia',
      'Ola',
    ]);
    const ola = res.body.staff[1];
    expect(ola.days).toEqual([
      {
        date: day,
        intervals: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
      { date: next, intervals: [{ start: '10:00', end: '12:00' }] },
    ]);
    expect(res.body.timeOff).toMatchObject([{ staffId: olaId, note: 'Lekarz' }]);
    expect(res.body.appointments).toHaveLength(1);
    expect(res.body.blocks).toMatchObject([{ staffId: null, reason: 'Zebranie' }]);
  });

  it('answers 304 while nothing has changed, and a new ETag after a change', async () => {
    const first = await calendar().expect(200);
    const etag = first.headers.etag as string;
    const again = await calendar().set('If-None-Match', etag).expect(304);
    expect(again.text).toBe('');

    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId,
        staffId: olaId,
        start: at(15),
        customer: { name: 'Anna', phone: '+48600000002' },
      })
      .expect(201);
    const changed = await calendar().set('If-None-Match', etag).expect(200);
    expect(changed.headers.etag).not.toBe(etag);
    expect(changed.body.appointments).toHaveLength(1);
  });

  it('a staff member sees only their own column, all columns with viewAllAppointments', async () => {
    const kasia = await signUp(ctx, 'kasia@example.com');
    const membership = await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.prisma.staffMember.update({ where: { id: kasiaId }, data: { userId: kasia.userId } });
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId,
        staffId: olaId,
        start: at(10),
        customer: { name: 'Anna', phone: '+48600000002' },
      })
      .expect(201);

    let res = await calendar(kasia.auth).expect(200);
    expect(res.body.staff.map((s: { id: string }) => s.id)).toEqual([kasiaId]);
    expect(res.body.appointments).toEqual([]);

    await ctx
      .http()
      .put(`/v1/organizations/${orgId}/members/${membership.id}/permissions`)
      .set(owner.auth)
      .send({ version: 1, staffCategoryId: null, overrides: { viewAllAppointments: true } })
      .expect(200);
    res = await calendar(kasia.auth).expect(200);
    expect(res.body.staff).toHaveLength(2);
    expect(res.body.appointments[0].customer).toMatchObject({ name: 'Anna', phone: null });
  });

  it('refuses ranges over 42 days', async () => {
    await calendar(owner.auth, day, addDays(day, 60)).expect(400);
  });
});
