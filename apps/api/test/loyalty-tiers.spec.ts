import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tierFor } from '../src/loyalty/loyalty-tiers';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 10e, part 1: the salon's client tiers, counted from paid visits or spend. */

const TZ = 'Europe/Warsaw';
const DAY_MS = 86_400_000;

let ctx: TestContext;
let kasia: SignedInUser;
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
  kasia = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: kasia.userId,
      organizationId: orgId,
      role: 'staff',
      locations: { create: [{ locationId: created.locationId }] },
    },
  });
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

const TIERS = [
  { name: 'Gold', threshold: 6, discountPercent: 10 },
  { name: 'Standard', threshold: 0, discountPercent: 0 },
  { name: 'Silver', threshold: 3, discountPercent: 5 },
];

const putTiers = (body: object, auth = owner.auth) =>
  ctx.http().put(`${loyalty()}/tiers`).set(auth).send(body);

/** A visit that happened `daysAgo` days ago, "came"; paid unless told otherwise. */
async function visit(
  opts: { email?: string; paid?: boolean; daysAgo?: number } = {},
): Promise<{ id: string; customerId: string }> {
  const day = addDays(localToday(Date.now(), TZ), 2);
  const start = new Date(zonedToInstant(day, hour++ * 60, TZ));
  const booked = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId,
      start: start.toISOString(),
      allowOutsideHours: true,
      customer: {
        name: 'Jan Nowak',
        phone: '+48600000002',
        email: opts.email ?? 'jan@example.com',
      },
    })
    .expect(201);
  const past = new Date(Date.now() - (opts.daysAgo ?? 1) * DAY_MS - hour * 60 * 60_000);
  await ctx.prisma.appointment.update({
    where: { id: booked.body.id },
    data: {
      startAt: past,
      endAt: new Date(past.getTime() + 30 * 60_000),
      blockedUntil: new Date(past.getTime() + 30 * 60_000),
    },
  });
  const came = await ctx
    .http()
    .post(`${base}/appointments/${booked.body.id}/status`)
    .set(owner.auth)
    .send({ version: booked.body.version, status: 'completed' })
    .expect(200);
  if (opts.paid !== false) {
    await ctx
      .http()
      .post(`${base}/appointments/${booked.body.id}/payment`)
      .set(owner.auth)
      .send({ version: came.body.version, paid: true })
      .expect(200);
  }
  return { id: booked.body.id, customerId: came.body.customer.id };
}

const tierOf = async (customerId: string) =>
  (await ctx.http().get(`${loyalty()}/accounts/${customerId}`).set(owner.auth).expect(200)).body
    .tier;

describe('client tiers', () => {
  it('the highest tier reached and what is missing for the next', () => {
    expect(tierFor(TIERS, 0)).toEqual({
      current: { name: 'Standard', discountPercent: 0 },
      next: { name: 'Silver', threshold: 3, missing: 3 },
    });
    expect(tierFor(TIERS, 7)).toEqual({
      current: { name: 'Gold', discountPercent: 10 },
      next: null,
    });
    expect(tierFor([{ name: 'VIP', threshold: 5, discountPercent: 15 }], 2)).toEqual({
      current: null,
      next: { name: 'VIP', threshold: 5, missing: 3 },
    });
  });

  it('the owner sets them; only owners and managers; thresholds differ', async () => {
    const empty = await ctx.http().get(`${loyalty()}/tiers`).set(owner.auth).expect(200);
    expect(empty.body).toEqual({ basis: 'visits', periodDays: 365, tiers: [] });
    const saved = await putTiers({ basis: 'visits', periodDays: 365, tiers: TIERS }).expect(200);
    expect(saved.body.tiers.map((t: { name: string }) => t.name)).toEqual([
      'Standard',
      'Silver',
      'Gold',
    ]);
    await putTiers({
      basis: 'visits',
      periodDays: 365,
      tiers: [TIERS[0], { ...TIERS[1], threshold: 6 }],
    }).expect(400);
    await putTiers({ basis: 'visits', periodDays: 365, tiers: [] }, kasia.auth).expect(403);
    await ctx.http().get(`${loyalty()}/tiers`).set(kasia.auth).expect(403);
  });

  it('counted from paid visits in the period', async () => {
    await putTiers({ basis: 'visits', periodDays: 365, tiers: TIERS }).expect(200);
    const first = await visit();
    expect(await tierOf(first.customerId)).toMatchObject({
      basis: 'visits',
      value: 1,
      current: { name: 'Standard' },
      next: { name: 'Silver', missing: 2 },
    });
    await visit({ paid: false }); // not paid: does not count
    await visit({ daysAgo: 400 }); // too long ago
    await visit();
    await visit();
    expect(await tierOf(first.customerId)).toMatchObject({
      value: 3,
      current: { name: 'Silver', discountPercent: 5 },
      next: { name: 'Gold', threshold: 6, missing: 3 },
    });
  });

  it('or from what the client paid; the client sees it in "Moje bonusy"', async () => {
    await putTiers({
      basis: 'spend',
      periodDays: 180,
      tiers: [{ name: 'VIP', threshold: 20_000, discountPercent: 15 }],
    }).expect(200);
    const first = await visit();
    expect(await tierOf(first.customerId)).toMatchObject({
      basis: 'spend',
      value: 8000,
      current: null,
      next: { name: 'VIP', missing: 12_000 },
    });
    await visit();
    await visit();

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
    expect(mine.body.items[0].tier).toMatchObject({
      value: 24_000,
      current: { name: 'VIP', discountPercent: 15 },
      next: null,
    });

    // No tiers: nothing to show.
    await putTiers({ basis: 'spend', periodDays: 180, tiers: [] }).expect(200);
    expect(await tierOf(first.customerId)).toBeNull();
  });
});
