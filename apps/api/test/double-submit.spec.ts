import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

// Owner's manual test 03.11.2026: a second tap on «Zapisz» while saving created a duplicate
// service (T4), and the service list looked unchanged after an edit (T2). The salon app
// sends one Idempotency-Key per form; answers are never kept by the browser.

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let base: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@double.test');
  const created = await createOrgWithLocation(ctx, owner, 'Double Barber');
  orgId = created.orgId;
  base = `/v1/organizations/${orgId}/locations/${created.locationId}`;
});

const SERVICE = { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 7000 };

describe('the same "add" sent twice creates one record', () => {
  it('service: a repeat with the same key returns the first one', async () => {
    const send = () =>
      ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .set('Idempotency-Key', 'service-form-0001')
        .send(SERVICE);
    const first = await send().expect(201);
    const again = await send().expect(201);
    expect(again.body.id).toBe(first.body.id);
    const list = await ctx.http().get(`${base}/services`).set(owner.auth).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('service: two taps at the same moment still give one service', async () => {
    const send = () =>
      ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .set('Idempotency-Key', 'service-form-0002')
        .send(SERVICE);
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toContain(201);
    for (const r of results) {
      if (r.status !== 201) expectError(r.body, 'REQUEST_IN_PROGRESS');
    }
    const list = await ctx.http().get(`${base}/services`).set(owner.auth).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('a new form (new key) may add a second service with the same name', async () => {
    for (const key of ['service-form-a001', 'service-form-b002']) {
      await ctx
        .http()
        .post(`${base}/services`)
        .set(owner.auth)
        .set('Idempotency-Key', key)
        .send(SERVICE)
        .expect(201);
    }
    const list = await ctx.http().get(`${base}/services`).set(owner.auth).expect(200);
    expect(list.body).toHaveLength(2);
  });

  it('specialist, category and client: the same key gives the same record', async () => {
    const twice = async (path: string, body: object, key: string) => {
      const a = await ctx.http().post(path).set(owner.auth).set('Idempotency-Key', key).send(body);
      const b = await ctx.http().post(path).set(owner.auth).set('Idempotency-Key', key).send(body);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.id).toBe(a.body.id);
    };
    await twice(`${base}/staff`, { displayName: 'Kasia' }, 'staff-form-0001');
    await twice(`${base}/service-categories`, { name: 'Włosy' }, 'category-form-0001');
    await twice(
      `/v1/organizations/${orgId}/customers`,
      { name: 'Jan Kowalski', phone: '+48600100200' },
      'client-form-0001',
    );
    const staff = await ctx.http().get(`${base}/staff`).set(owner.auth).expect(200);
    expect(staff.body).toHaveLength(1);
  });
});

describe('answers are not kept by the browser (T2)', () => {
  it('lists say Cache-Control: no-store; an edit is visible on the next read', async () => {
    const created = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send(SERVICE)
      .expect(201);
    const before = await ctx.http().get(`${base}/services`).set(owner.auth).expect(200);
    expect(before.headers['cache-control']).toBe('no-store');

    const edited = await ctx
      .http()
      .patch(`${base}/services/${created.body.id}`)
      .set(owner.auth)
      .send({ version: created.body.version, active: false })
      .expect(200);
    expect(edited.body).toMatchObject({ id: created.body.id, active: false });
    const after = await ctx.http().get(`${base}/services`).set(owner.auth).expect(200);
    expect(after.body[0]).toMatchObject({ id: created.body.id, active: false });
  });
});
