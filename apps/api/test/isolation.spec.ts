import { RequestMethod } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrgWithLocation,
  createTestApp,
  LOCATION,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Tenant isolation: a user of organization A calls EVERY organization-scoped
 * endpoint with ids that belong to organization B — B's organization, B's
 * location inside A's organization path, and B's services/staff/time off inside
 * A's own location. Routes are discovered automatically, so a new endpoint is
 * covered without anyone remembering to add it here.
 */

interface Route {
  method: string;
  path: string;
}

type Ids = Record<'orgId' | 'locationId' | 'serviceId' | 'staffId' | 'timeOffId' | 'date', string>;

// Nest's own metadata keys (PATH_METADATA / METHOD_METADATA).
const PATH = 'path';
const METHOD = 'method';
const DATE = '2027-01-04';

function discoverRoutes(ctx: TestContext): Route[] {
  const routes: Route[] = [];
  for (const wrapper of ctx.app.get(DiscoveryService).getControllers()) {
    const controller = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!controller) continue;
    const base = String(Reflect.getMetadata(PATH, controller) ?? '');
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD, handler) as RequestMethod | undefined;
      const sub = Reflect.getMetadata(PATH, handler) as string | undefined;
      if (method === undefined || sub === undefined) continue;
      const path = ['/v1', base, sub]
        .map((p) => p.replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/');
      routes.push({ method: RequestMethod[method].toLowerCase(), path: `/${path}` });
    }
  }
  return routes;
}

/**
 * A body that passes validation, so the request reaches the access check
 * (an invalid body would be rejected with 400 first and prove nothing).
 */
function validBody(route: Route): object {
  const p = route.path;
  if (p.endsWith('/working-hours/overrides/:date')) {
    return { intervals: [{ start: '09:00', end: '10:00' }] };
  }
  if (p.endsWith('/working-hours')) return { days: [] };
  if (p.endsWith('/time-off')) return { start: `${DATE}T09:00`, end: `${DATE}T10:00` };
  if (p.endsWith('/staff/:staffId/services')) return { serviceIds: [] };
  if (p.endsWith('/staff/:staffId')) return { version: 1, displayName: 'Hacked' };
  if (p.endsWith('/staff')) return { displayName: 'Hacked' };
  if (p.endsWith('/services/:serviceId')) return { version: 1, name: 'Hacked' };
  if (p.endsWith('/services')) return { name: 'Hacked', durationMinutes: 30, priceGrosze: 100 };
  if (p.endsWith('/locations/:locationId')) return { version: 1, name: 'Hacked' };
  if (p.endsWith('/locations')) return LOCATION;
  if (p.endsWith('/organizations/:orgId')) return { name: 'Hacked' };
  throw new Error(`isolation.spec.ts: add a valid body for ${route.method.toUpperCase()} ${p}`);
}

function urlFor(route: Route, ids: Ids): string {
  const path = route.path.replace(/:(\w+)/g, (_, param: string) => {
    if (param in ids) return ids[param as keyof Ids];
    throw new Error(`isolation.spec.ts: add an id for ":${param}" (${route.path})`);
  });
  return path.endsWith('/availability')
    ? `${path}?serviceId=${ids.serviceId}&from=${DATE}&to=${DATE}`
    : path;
}

function send(route: Route, url: string, user: SignedInUser) {
  const agent = ctx.http();
  switch (route.method) {
    case 'get':
      return agent.get(url).set(user.auth);
    case 'delete':
      return agent.delete(url).set(user.auth);
    case 'post':
      return agent.post(url).set(user.auth).send(validBody(route));
    case 'patch':
      return agent.patch(url).set(user.auth).send(validBody(route));
    case 'put':
      return agent.put(url).set(user.auth).send(validBody(route));
    default:
      throw new Error(`isolation.spec.ts: unsupported method ${route.method}`);
  }
}

/** Creates a service, a staff member with hours, a special day and time off. */
async function seedLocation(
  user: SignedInUser,
  org: { orgId: string; locationId: string },
): Promise<Ids> {
  const base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(user.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 6000 })
    .expect(201);
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(user.auth)
    .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
    .expect(201);
  const staffUrl = `${base}/staff/${staff.body.id}`;
  await ctx
    .http()
    .put(`${staffUrl}/working-hours`)
    .set(user.auth)
    .send({ days: [{ weekday: 1, intervals: [{ start: '09:00', end: '17:00' }] }] })
    .expect(200);
  await ctx
    .http()
    .put(`${staffUrl}/working-hours/overrides/${DATE}`)
    .set(user.auth)
    .send({ intervals: [{ start: '10:00', end: '14:00' }] })
    .expect(200);
  const timeOff = await ctx
    .http()
    .post(`${staffUrl}/time-off`)
    .set(user.auth)
    .send({ start: '2027-02-01T00:00', end: '2027-02-08T00:00' })
    .expect(201);
  return {
    orgId: org.orgId,
    locationId: org.locationId,
    serviceId: service.body.id,
    staffId: staff.body.id,
    timeOffId: timeOff.body.id,
    date: DATE,
  };
}

/** Everything organization B owns, to compare before and after the attack. */
async function snapshotOf(ids: Ids) {
  return {
    organization: await ctx.prisma.organization.findUnique({ where: { id: ids.orgId } }),
    location: await ctx.prisma.location.findUnique({ where: { id: ids.locationId } }),
    services: await ctx.prisma.service.findMany({ where: { locationId: ids.locationId } }),
    staff: await ctx.prisma.staffMember.findMany({
      where: { locationId: ids.locationId },
      include: { services: true, workingHours: true, overrides: true, timeOff: true },
    }),
  };
}

let ctx: TestContext;
let alice: SignedInUser;
let aliceIds: Ids;
let bobIds: Ids;

beforeAll(async () => {
  ctx = await createTestApp();
  await resetState(ctx);
  alice = await signUp(ctx, 'alice@example.com');
  aliceIds = await seedLocation(alice, await createOrgWithLocation(ctx, alice, 'Alice Salon'));
  const bob = await signUp(ctx, 'bob@example.com');
  bobIds = await seedLocation(bob, await createOrgWithLocation(ctx, bob, 'Bob Barber'));
});

afterAll(async () => {
  await ctx.app.close();
});

describe('tenant isolation', () => {
  const scoped = () => discoverRoutes(ctx).filter((r) => r.path.includes(':orgId'));

  it('finds the organization-scoped endpoints', () => {
    expect(scoped().length).toBeGreaterThanOrEqual(20);
  });

  const scenarios: { name: string; ids: () => Ids; applies: (r: Route) => boolean }[] = [
    {
      name: "B's organization",
      ids: () => bobIds,
      applies: () => true,
    },
    {
      name: "B's location under A's organization",
      ids: () => ({ ...bobIds, orgId: aliceIds.orgId }),
      applies: (r) => r.path.includes(':locationId'),
    },
    {
      name: "B's services and staff under A's own location",
      ids: () => ({ ...bobIds, orgId: aliceIds.orgId, locationId: aliceIds.locationId }),
      applies: (r) => /:(serviceId|staffId)/.test(r.path) || r.path.endsWith('/availability'),
    },
    {
      name: "B's time off under A's own staff member",
      ids: () => ({ ...aliceIds, timeOffId: bobIds.timeOffId }),
      applies: (r) => r.path.includes(':timeOffId'),
    },
  ];

  for (const scenario of scenarios) {
    it(`returns 404 and changes nothing: ${scenario.name}`, async () => {
      const before = await snapshotOf(bobIds);
      const routes = scoped().filter(scenario.applies);
      expect(routes.length).toBeGreaterThan(0);

      for (const route of routes) {
        const res = await send(route, urlFor(route, scenario.ids()), alice);
        const label = `${route.method.toUpperCase()} ${route.path}`;
        expect(res.status, label).toBe(404);
        expect(res.body.error?.code, label).toBe('NOT_FOUND');
      }

      expect(await snapshotOf(bobIds)).toEqual(before);
    });
  }

  it('answers the same for a non-existent or malformed organization id', async () => {
    await ctx
      .http()
      .get('/v1/organizations/00000000-0000-7000-8000-000000000000/locations')
      .set(alice.auth)
      .expect(404);
    await ctx.http().get('/v1/organizations/not-a-uuid/locations').set(alice.auth).expect(404);
  });

  it("does not list another organization's data", async () => {
    const orgs = await ctx.http().get('/v1/organizations').set(alice.auth).expect(200);
    expect(orgs.body.map((o: { name: string }) => o.name)).toEqual(['Alice Salon']);
  });

  it("cannot assign another location's service to own staff", async () => {
    const res = await ctx
      .http()
      .put(
        `/v1/organizations/${aliceIds.orgId}/locations/${aliceIds.locationId}/staff/${aliceIds.staffId}/services`,
      )
      .set(alice.auth)
      .send({ serviceIds: [bobIds.serviceId] })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
