import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientExportResponse } from '../src/client/client-export.responses';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** "Download my data" in the client app (task 22): GDPR access and portability. */

const TZ = 'Europe/Warsaw';
const ANNA = 'anna.export@example.com';
const BOB = 'bob.export@example.com';
const SECRET = 'Secret staff note about the client';

interface Salon {
  owner: SignedInUser;
  orgId: string;
  base: string;
  serviceId: string;
  staffId: string;
}

let ctx: TestContext;
let hour = 9;

function expectShape(name: string, body: unknown): void {
  const result = registeredResponseSchema(name).safeParse(body);
  expect(result.error?.issues ?? [], `response does not match ${name}`).toEqual([]);
}

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  hour = 9;
});

async function setupSalon(ownerEmail: string, name: string): Promise<Salon> {
  const owner = await signUp(ctx, ownerEmail);
  const { orgId, locationId } = await createOrgWithLocation(ctx, owner, name);
  const base = `/v1/organizations/${orgId}/locations/${locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
    .expect(201);
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
    .expect(201);
  return { owner, orgId, base, serviceId: service.body.id, staffId: staff.body.id };
}

/** A visit booked by the salon (in two days); returns the visit and the client card. */
async function book(salon: Salon, email: string, name: string) {
  const day = addDays(localToday(Date.now(), TZ), 2);
  const start = new Date(zonedToInstant(day, hour++ * 60, TZ));
  const res = await ctx
    .http()
    .post(`${salon.base}/appointments`)
    .set(salon.owner.auth)
    .send({
      serviceId: salon.serviceId,
      staffId: salon.staffId,
      start: start.toISOString(),
      allowOutsideHours: true,
      customer: { name, phone: '+48600100200', email },
      note: 'Visit note for the team',
    })
    .expect(201);
  return {
    id: res.body.id as string,
    version: res.body.version as number,
    customerId: res.body.customer.id as string,
  };
}

function lastCode(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code sent to ${email}`);
  return match[1];
}

async function signIn(email: string): Promise<{ Authorization: string }> {
  await ctx.http().post('/v1/client/auth/code').send({ email, locale: 'pl' }).expect(202);
  const res = await ctx
    .http()
    .post('/v1/client/auth/verify')
    .send({ email, code: lastCode(email), clientType: 'mobile' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.token}` };
}

async function myData(email: string): Promise<ClientExportResponse> {
  const res = await ctx
    .http()
    .get('/v1/client/export')
    .set(await signIn(email))
    .expect(200);
  expectShape('ClientDataExport', res.body);
  return res.body as ClientExportResponse;
}

describe('GET /v1/client/export', () => {
  it('needs the client sign-in', async () => {
    await ctx.http().get('/v1/client/export').expect(401);
    const salon = await setupSalon('owner.export@example.com', 'Gestalt');
    // A salon account is not a client session.
    await ctx.http().get('/v1/client/export').set(salon.owner.auth).expect(401);
  });

  it('gives the card, visits and loyalty in every salon, without staff notes or other clients', async () => {
    const a = await setupSalon('owner.a@example.com', 'Gestalt Barbershop');
    const b = await setupSalon('owner.b@example.com', 'Berber Moda');
    const first = await book(a, ANNA, 'Anna Kowalska');
    await book(a, BOB, 'Bob Nowak');
    await book(b, ANNA, 'Anna K.');

    // The salon's own note and tags stay with the salon.
    const card = await ctx
      .http()
      .get(`/v1/organizations/${a.orgId}/customers/${first.customerId}`)
      .set(a.owner.auth)
      .expect(200);
    await ctx
      .http()
      .patch(`/v1/organizations/${a.orgId}/customers/${first.customerId}`)
      .set(a.owner.auth)
      .send({ version: card.body.version, note: SECRET, tags: ['secret-tag'] })
      .expect(200);

    // Loyalty in salon A: a manual correction with a reason only the team sees.
    const program = await ctx
      .http()
      .get(`/v1/organizations/${a.orgId}/loyalty/program`)
      .set(a.owner.auth);
    await ctx
      .http()
      .put(`/v1/organizations/${a.orgId}/loyalty/program`)
      .set(a.owner.auth)
      .send({
        version: program.body.version,
        enabled: true,
        mode: 'points',
        stampsPerVisit: 1,
        pointsPerUnit: 10,
        spendUnitGrosze: 10_000,
        minSpendGrosze: 0,
        pointsValidityDays: null,
        maxDiscountPercent: 100,
        allowStacking: false,
        marketplaceEnabled: false,
      })
      .expect(200);
    await ctx
      .http()
      .post(`/v1/organizations/${a.orgId}/loyalty/accounts/${first.customerId}/adjustments`)
      .set(a.owner.auth)
      .send({ points: 25, reason: SECRET })
      .expect(201);

    // Salon B cancels Anna's visit with a reason the client reads anyway.
    const [bVisit] = (
      await ctx
        .http()
        .get(`${b.base}/calendar`)
        .query({
          from: localToday(Date.now(), TZ),
          to: addDays(localToday(Date.now(), TZ), 3),
        })
        .set(b.owner.auth)
        .expect(200)
    ).body.appointments as { id: string }[];
    const bDetail = await ctx.http().get(`${b.base}/appointments/${bVisit!.id}`).set(b.owner.auth);
    await ctx
      .http()
      .post(`${b.base}/appointments/${bVisit!.id}/cancel`)
      .set(b.owner.auth)
      .send({ version: bDetail.body.version, reason: 'Kasia jest chora' })
      .expect(200);

    const data = await myData(ANNA);
    expect(data.person.email).toBe(ANNA);
    expect(data.salons.map((s) => s.salon).sort()).toEqual(['Berber Moda', 'Gestalt Barbershop']);

    const inA = data.salons.find((s) => s.salon === 'Gestalt Barbershop')!;
    expect(inA.client).toMatchObject({ name: 'Anna Kowalska', phone: '+48600100200', email: ANNA });
    expect(inA.visits).toHaveLength(1);
    expect(inA.visits[0]).toMatchObject({
      id: first.id,
      service: 'Strzyżenie',
      staff: 'Kasia',
      status: 'confirmed',
      source: 'manual',
      priceGrosze: 8000,
      currency: 'PLN',
      paid: false,
      cancelledBy: null,
    });
    expect(inA.visits[0]!.time).toBe('09:00');
    expect(inA.loyalty).toHaveLength(1);
    expect(inA.loyalty[0]).toMatchObject({ balance: 25, coupons: [] });
    expect(inA.loyalty[0]!.history).toEqual([
      expect.objectContaining({ type: 'adjust', points: 25, balanceAfter: 25 }),
    ]);

    const inB = data.salons.find((s) => s.salon === 'Berber Moda')!;
    expect(inB.client.name).toBe('Anna K.');
    expect(inB.visits[0]).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'salon',
      cancelReason: 'Kasia jest chora',
    });
    expect(inB.loyalty).toEqual([]);

    // Nothing the team keeps for itself, nothing about Bob.
    const text = JSON.stringify(data);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secret-tag');
    expect(text).not.toContain('Visit note for the team');
    expect(text).not.toContain('Bob');
    expect(text).not.toContain(BOB);
  });

  it('is empty for a person no salon knows yet', async () => {
    const data = await myData('new.person@example.com');
    expect(data.salons).toEqual([]);
    expect(data.person.email).toBe('new.person@example.com');
  });
});
