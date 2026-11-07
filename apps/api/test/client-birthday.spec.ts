import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { birthdayWindow } from '../src/booking/customers.service';
import { instantToLocal } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Task 240: the client's birthday — day and month only, no year. Written in the card by the
 * owner or manager, seen with the client's contacts, listed as "birthdays in the next days"
 * (soonest first), erased with the rest of the personal data.
 */

const FIVE_MIN = 5 * 60_000;
const DAY = 24 * 60 * 60_000;

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let customersBase: string;

const fromNow = (ms: number): string =>
  new Date(Math.floor((Date.now() + ms) / FIVE_MIN) * FIVE_MIN).toISOString();

/** "MM-DD" of the salon's day `days` from today (Warsaw). */
const mmdd = (days: number): string =>
  instantToLocal(Date.now() + days * DAY, 'Europe/Warsaw').date.slice(5);

async function client(name: string, phone: string, birthday?: string): Promise<string> {
  return (
    await ctx
      .http()
      .post(customersBase)
      .set(owner.auth)
      .send({ name, phone, ...(birthday ? { birthday } : {}) })
      .expect(201)
  ).body.id;
}

const birthdays = async (days: number, auth = owner.auth) => {
  const res = await ctx
    .http()
    .get(customersBase)
    .query({ birthdayDays: days })
    .set(auth)
    .expect(200);
  expect(registeredResponseSchema('CustomerList').safeParse(res.body).error?.issues ?? []).toEqual(
    [],
  );
  return res.body.map((c: { name: string; birthday: string }) => `${c.name} ${c.birthday}`);
};

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
  customersBase = `/v1/organizations/${orgId}/customers`;
});

describe('client birthday (task 240)', () => {
  it('is written in the card as day and month, changed and removed', async () => {
    const jan = await client('Jan Nowak', '+48600000001', '03-15');
    const card = await ctx.http().get(`${customersBase}/${jan}`).set(owner.auth).expect(200);
    expect(card.body.birthday).toBe('03-15');

    const changed = await ctx
      .http()
      .patch(`${customersBase}/${jan}`)
      .set(owner.auth)
      .send({ version: card.body.version, birthday: '02-29' })
      .expect(200);
    expect(changed.body.birthday).toBe('02-29');
    const removed = await ctx
      .http()
      .patch(`${customersBase}/${jan}`)
      .set(owner.auth)
      .send({ version: changed.body.version, birthday: null })
      .expect(200);
    expect(removed.body.birthday).toBeNull();

    // No such day, a year, or another format are refused.
    for (const birthday of ['02-30', '13-01', '00-10', '04-31', '1990-03-15', '3-5']) {
      await ctx
        .http()
        .post(customersBase)
        .set(owner.auth)
        .send({ name: 'Zły', phone: '+48600000009', birthday })
        .expect(400);
    }
  });

  it('lists the birthdays of the next days, soonest first', async () => {
    await client('Jutro', '+48600000001', mmdd(1));
    await client('Dziś', '+48600000002', mmdd(0));
    await client('Za tydzień', '+48600000003', mmdd(7));
    await client('Wczoraj', '+48600000004', mmdd(-1));
    await client('Bez daty', '+48600000005');
    await client('Też dziś', '+48600000006', mmdd(0));

    expect(await birthdays(1)).toEqual([`Dziś ${mmdd(0)}`, `Też dziś ${mmdd(0)}`]);
    expect(await birthdays(7)).toEqual([
      `Dziś ${mmdd(0)}`,
      `Też dziś ${mmdd(0)}`,
      `Jutro ${mmdd(1)}`,
    ]);
    expect(await birthdays(8)).toEqual([
      `Dziś ${mmdd(0)}`,
      `Też dziś ${mmdd(0)}`,
      `Jutro ${mmdd(1)}`,
      `Za tydzień ${mmdd(7)}`,
    ]);
    // Together with the search; more than a month ahead is refused.
    expect(
      (
        await ctx
          .http()
          .get(customersBase)
          .query({ birthdayDays: 7, search: 'też' })
          .set(owner.auth)
          .expect(200)
      ).body.map((c: { name: string }) => c.name),
    ).toEqual(['Też dziś']);
    await ctx.http().get(customersBase).query({ birthdayDays: 32 }).set(owner.auth).expect(400);
  });

  it('counts 29 February as 28 February in a year without it, across the new year too', () => {
    expect([...birthdayWindow('2027-02-27', 3)]).toEqual([
      ['02-27', 0],
      ['02-28', 1],
      ['02-29', 1],
      ['03-01', 2],
    ]);
    expect([...birthdayWindow('2028-02-28', 2)]).toEqual([
      ['02-28', 0],
      ['02-29', 1],
    ]);
    expect([...birthdayWindow('2026-12-31', 2)]).toEqual([
      ['12-31', 0],
      ['01-01', 1],
    ]);
  });

  it('is erased with the personal data and is in the GDPR export', async () => {
    const jan = await client('Jan Nowak', '+48600000001', mmdd(0));
    const exported = await ctx
      .http()
      .get(`${customersBase}/${jan}/export`)
      .set(owner.auth)
      .expect(200);
    expect(exported.body.client.birthday).toBe(mmdd(0));
    await ctx
      .http()
      .post(`${customersBase}/${jan}/anonymize`)
      .set(owner.auth)
      .send({ version: 1 })
      .expect(200);
    const row = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: jan } });
    expect(row.birthday).toBeNull();
    expect(await birthdays(1)).toEqual([]);
  });

  it('a specialist without contacts does not see it or change it; other salons see nothing', async () => {
    const haircutId = (
      await ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
        .expect(201)
    ).body.id;
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        permissionOverrides: { editClientNotes: true, viewClientNotes: true },
        locations: { create: [{ locationId }] },
      },
    });
    const staffId = (
      await ctx
        .http()
        .post(`${base}/staff`)
        .set(owner.auth)
        .send({ displayName: 'Kasia', serviceIds: [haircutId] })
        .expect(201)
    ).body.id;
    await ctx.prisma.staffMember.update({ where: { id: staffId }, data: { userId: kasia.userId } });
    const jan = await client('Jan Nowak', '+48600000001', '05-20');
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: haircutId,
        staffId,
        start: fromNow(2 * DAY),
        customerId: jan,
        allowOutsideHours: true,
      })
      .expect(201);

    const seen = await ctx.http().get(`${customersBase}/${jan}`).set(kasia.auth);
    if (seen.status === 200) {
      expect(seen.body.phone).toBeNull();
      expect(seen.body.birthday).toBeNull();
      await ctx
        .http()
        .patch(`${customersBase}/${jan}`)
        .set(kasia.auth)
        .send({ version: seen.body.version, birthday: '01-01' })
        .expect(403);
    } else {
      expect(seen.status).toBe(404);
    }
    const row = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: jan } });
    expect(row.birthday).toBe('05-20');
    // The list is for owners and managers only.
    await ctx.http().get(customersBase).query({ birthdayDays: 7 }).set(kasia.auth).expect(403);

    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Inny');
    expect(
      (
        await ctx
          .http()
          .get(`/v1/organizations/${other.orgId}/customers`)
          .query({ birthdayDays: 31 })
          .set(stranger.auth)
          .expect(200)
      ).body,
    ).toEqual([]);
  });
});
