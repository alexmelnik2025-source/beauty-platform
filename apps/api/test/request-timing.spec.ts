import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatTiming, type RequestTiming } from '../src/common/request-timing';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

// Owner's manual test 03.11.2026 (T1): signed-in requests took 2–10 s locally. Development
// now logs every request with its time and database share, and the browser sees the same
// numbers in the Server-Timing header.

let ctx: TestContext;
let plain: TestContext;
const timings: RequestTiming[] = [];
let owner: SignedInUser;
let base: string;

beforeAll(async () => {
  ctx = await createTestApp({ timing: (t) => timings.push(t) });
  plain = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
  await plain.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@timing.test');
  const { orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Timing Barber');
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  timings.length = 0;
});

const lastFor = (path: string): RequestTiming | undefined =>
  timings.filter((t) => t.path === path).at(-1);

describe('request timing (local development)', () => {
  it('reports each request with its status, time and database queries', async () => {
    const res = await ctx
      .http()
      .get(`${base}/calendar`)
      .query({ from: '2026-11-04', to: '2026-11-04' })
      .set(owner.auth)
      .expect(200);

    const timing = lastFor(`${base}/calendar`);
    expect(timing).toMatchObject({ method: 'GET', status: 200 });
    // Membership check + the calendar itself.
    expect(timing!.dbQueries).toBeGreaterThanOrEqual(2);
    expect(timing!.totalMs).toBeGreaterThanOrEqual(0);
    expect(res.headers['server-timing']).toMatch(/^api;dur=\d+, db;dur=\d+;desc="\d+ queries"$/);
    expect(formatTiming(timing!)).toMatch(
      /^GET \/v1\/organizations\/.+\/calendar 200 \d+ ms \(db: \d+ queries, \d+ ms\)$/,
    );
  });

  it('leaves the query string (codes, tokens) out of the logged path', async () => {
    await ctx.http().get('/v1/health').query({ token: 'secret-value' }).expect(200);
    const timing = lastFor('/v1/health');
    expect(timing?.path).toBe('/v1/health');
    expect(formatTiming(timing!)).not.toContain('secret-value');
  });

  it('counts only the queries of its own request when requests run at the same time', async () => {
    await Promise.all([
      ctx.http().get('/v1/me/notifications/unread-count').set(owner.auth).expect(200),
      ctx
        .http()
        .get(`${base}/calendar`)
        .query({ from: '2026-11-04', to: '2026-11-04' })
        .set(owner.auth)
        .expect(200),
    ]);
    const unread = lastFor('/v1/me/notifications/unread-count');
    expect(unread?.dbQueries).toBe(1);
  });

  it('times failed requests too (401 without a token)', async () => {
    await ctx.http().get('/v1/me/notifications/unread-count').expect(401);
    expect(lastFor('/v1/me/notifications/unread-count')).toMatchObject({
      status: 401,
      dbQueries: 0,
    });
  });

  it('a signed-in request with database work stays well under a second', async () => {
    const unread = () =>
      ctx.http().get('/v1/me/notifications/unread-count').set(owner.auth).expect(200);
    await unread(); // warm-up
    await unread();
    expect(lastFor('/v1/me/notifications/unread-count')!.totalMs).toBeLessThan(1000);
  });

  it('is off unless asked for: no Server-Timing header in production setup', async () => {
    const res = await plain.http().get('/v1/health').expect(200);
    expect(res.headers['server-timing']).toBeUndefined();
  });
});
