import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildOpenApiDocument, registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type TestContext,
} from './helpers';

/**
 * The OpenAPI document is saved in packages/api-client, and the typed client is generated
 * from it. When the API changes, refresh it:
 *   OPENAPI_WRITE=1 pnpm --filter @beauty/api exec vitest run test/openapi.spec.ts
 *   pnpm --filter @beauty/api-client generate
 */
const SAVED = resolve(__dirname, '../../../packages/api-client/openapi.json');
const TZ = 'Europe/Warsaw';
const ANNA = 'anna.client@example.com';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

/** Fails when a response has a field the schema does not describe, or lacks one it does. */
function expectShape(name: string, body: unknown): void {
  const result = registeredResponseSchema(name).safeParse(body);
  expect(result.error?.issues ?? [], `response does not match ${name}`).toEqual([]);
}

function refsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') found.push(item);
      else refsIn(item, found);
    }
  }
  return found;
}

describe('OpenAPI document', () => {
  it('is the one saved in packages/api-client (the typed client is generated from it)', () => {
    const text = `${JSON.stringify(buildOpenApiDocument(ctx.app), null, 2)}\n`;
    if (process.env.OPENAPI_WRITE === '1') writeFileSync(SAVED, text);
    expect(
      readFileSync(SAVED, 'utf8') === text,
      'packages/api-client/openapi.json is out of date: see the comment at the top of this test',
    ).toBe(true);
  });

  it('every schema reference points to a described schema', () => {
    const document = buildOpenApiDocument(ctx.app);
    const names = Object.keys(document.components?.schemas ?? {});
    const refs = refsIn(document.paths);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(names).toContain(ref.replace('#/components/schemas/', ''));
    }
  });

  it('serves the same document at /v1/docs-json', async () => {
    const res = await ctx.http().get('/v1/docs-json').expect(200);
    expect(res.body).toEqual(JSON.parse(readFileSync(SAVED, 'utf8')));
  });
});

describe('client-facing responses match the documented shapes exactly', () => {
  let slug: string;
  let serviceId: string;
  let staffId: string;

  beforeEach(async () => {
    await resetState(ctx);
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await createOrgWithLocation(ctx, owner, 'Barber One');
    slug = org.slug;
    const base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
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
  });

  function lastCode(email: string): string {
    const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
    if (!match?.[1]) throw new Error(`no code sent to ${email}`);
    return match[1];
  }

  it('booking page, booking steps, manage link and "My visits"', async () => {
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expectShape('PublicLocation', page.body);

    const day = addDays(localToday(Date.now(), TZ), 3);
    const availability = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/availability`)
      .query({ serviceId, from: day, to: day })
      .expect(200);
    expectShape('Availability', availability.body);
    expect(availability.body.slots.length).toBeGreaterThan(0);
    expectShape('Slot', availability.body.slots[0]);

    const start = new Date(zonedToInstant(day, 10 * 60, TZ)).toISOString();
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start })
      .expect(201);
    expectShape('Hold', hold.body);

    const code = await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({
        holdToken: hold.body.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100200',
        email: ANNA,
        locale: 'pl',
        acceptTerms: true,
      })
      .expect(202);
    expectShape('CodeSent', code.body);

    const confirmed = await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
      .send({ holdToken: hold.body.holdToken, code: lastCode(ANNA) })
      .expect(200);
    expectShape('BookingConfirmed', confirmed.body);

    const managed = await ctx
      .http()
      .get(`/v1/public/appointments/${confirmed.body.manageToken}`)
      .expect(200);
    expectShape('PublicAppointment', managed.body);

    const sent = await ctx
      .http()
      .post('/v1/client/auth/code')
      .send({ email: ANNA, locale: 'pl' })
      .expect(202);
    expectShape('ClientCodeSent', sent.body);
    const signedIn = await ctx
      .http()
      .post('/v1/client/auth/verify')
      .send({ email: ANNA, code: lastCode(ANNA), clientType: 'mobile' })
      .expect(200);
    expectShape('ClientSignIn', signedIn.body);
    const auth = { Authorization: `Bearer ${signedIn.body.token}` };

    const me = await ctx.http().get('/v1/client/me').set(auth).expect(200);
    expectShape('ClientPerson', me.body);
    const list = await ctx.http().get('/v1/client/appointments').set(auth).expect(200);
    expectShape('ClientAppointmentList', list.body);
    expect(list.body.items).toHaveLength(1);
    const one = await ctx
      .http()
      .get(`/v1/client/appointments/${confirmed.body.appointment.id}`)
      .set(auth)
      .expect(200);
    expectShape('ClientAppointment', one.body);
    expect(one.body.bookAgain).toEqual({ slug, serviceId, staffId });
  });

  it('a schema with an extra field would fail: shapes are strict', () => {
    expect(
      registeredResponseSchema('ClientPerson').safeParse({
        id: 'x',
        email: ANNA,
        locale: 'pl',
        phone: '+48600100200',
      }).success,
    ).toBe(false);
  });
});
