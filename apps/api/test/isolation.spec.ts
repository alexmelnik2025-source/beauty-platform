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

type Ids = Record<
  | 'orgId'
  | 'locationId'
  | 'serviceId'
  | 'staffId'
  | 'timeOffId'
  | 'date'
  | 'appointmentId'
  | 'customerId'
  | 'categoryId'
  | 'membershipId'
  | 'blockId'
  | 'seriesId'
  | 'serviceCategoryId'
  | 'invitationId'
  | 'photoId'
  | 'rewardId'
  | 'couponId'
  | 'entryId',
  string
>;

/** A tiny file with PNG's first bytes: enough to pass the photo type check. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png'),
]);

const REWARD = { name: 'Hacked', kind: 'discount_percent', discountPercent: 100, cost: 1 };

/** Monday 11.01.2027 09:00 in Warsaw. */
const APPOINTMENT_START = '2027-01-11T08:00:00.000Z';

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
  if (p.endsWith('/photos') || p.endsWith('/staff/:staffId/photo')) return PNG;
  if (p.endsWith('/invitations')) {
    return { email: 'hacker@example.com', role: 'staff', locationIds: [currentIds?.locationId] };
  }
  if (p.endsWith('/members/:membershipId/permissions')) {
    return { version: 1, staffCategoryId: null, overrides: { viewClientContacts: true } };
  }
  if (p.endsWith('/service-categories/:serviceCategoryId')) return { version: 1, name: 'Hacked' };
  if (p.endsWith('/service-categories')) return { name: 'Hacked' };
  if (p.endsWith('/customers/:customerId/anonymize')) return { version: 1 };
  if (p.endsWith('/staff-prices')) return { prices: [] };
  if (p.endsWith('/customers/:customerId')) return { version: 1, name: 'Hacked' };
  if (p.endsWith('/customers')) return { name: 'Hacker', phone: '+48500000001' };
  if (p.endsWith('/time-blocks/:blockId')) return { version: 1, reason: 'Hacked' };
  if (p.endsWith('/time-blocks/series')) {
    return {
      staffId: null,
      start: '2027-01-12T10:00:00.000Z',
      end: '2027-01-12T11:00:00.000Z',
      weeks: 2,
    };
  }
  if (p.endsWith('/time-blocks')) {
    return { staffId: null, start: '2027-01-12T10:00:00.000Z', end: '2027-01-12T11:00:00.000Z' };
  }
  if (p.endsWith('/staff-categories/:categoryId')) return { version: 1, name: 'Hacked' };
  if (p.endsWith('/staff-categories')) return { name: 'Hacked' };
  if (p.endsWith('/appointments/:appointmentId/reschedule')) {
    return { version: 1, start: '2027-01-11T10:00:00.000Z', allowOutsideHours: true };
  }
  if (p.endsWith('/appointments/:appointmentId/cancel')) return { version: 1, reason: 'Hacked' };
  if (p.endsWith('/appointments/:appointmentId/status')) return { version: 1, status: 'no_show' };
  if (p.endsWith('/appointments/:appointmentId/approve')) return { version: 1 };
  if (p.endsWith('/appointments/:appointmentId/payment')) return { version: 1, paid: true };
  if (p.endsWith('/loyalty/program')) {
    return {
      version: 0,
      enabled: true,
      mode: 'points',
      stampsPerVisit: 1,
      pointsPerUnit: 1000,
      spendUnitGrosze: 1,
      minSpendGrosze: 0,
      pointsValidityDays: null,
      maxDiscountPercent: 100,
      allowStacking: true,
      marketplaceEnabled: true,
    };
  }
  if (p.endsWith('/staff/:staffId/languages')) return { languages: ['pl'] };
  if (p.endsWith('/loyalty/tiers')) {
    return {
      basis: 'visits',
      periodDays: 365,
      tiers: [{ name: 'VIP', threshold: 1, discountPercent: 50 }],
    };
  }
  if (p.endsWith('/loyalty/bonus-rules')) {
    return { rules: [{ name: 'Hacked', weekdays: [1], multiplier: 10 }] };
  }
  if (p.endsWith('/loyalty/rewards/:rewardId')) return { version: 1, ...REWARD };
  if (p.endsWith('/loyalty/rewards')) return REWARD;
  if (p.endsWith('/adjustments')) return { points: 1000, reason: 'Hacked' };
  if (p.endsWith('/redemptions')) return { rewardId: currentIds?.rewardId };
  if (p.endsWith('/coupons/:couponId/cancel')) return { version: 1 };
  if (p.endsWith('/coupons/:couponId/remove')) return { version: 1 };
  if (p.endsWith('/tier-discount') || p.endsWith('/tier-discount/remove')) return { version: 1 };
  if (p.endsWith('/waitlist/:entryId/remove')) return {};
  if (p.endsWith('/review-settings')) return { version: 0, enabled: true, requestHours: 2 };
  if (p.endsWith('/cancellation-guard/clients/:customerId/release')) return { note: 'Hacked' };
  if (p.endsWith('/cancellation-guard')) {
    return {
      version: 0,
      enabled: true,
      maxChanges: 1,
      windowHours: 24,
      lateCancelMinutes: null,
      maxNoShows: null,
      action: 'phone_only',
    };
  }
  if (p.endsWith('/services/:serviceId/staff-durations')) return { durations: [] };
  if (p.endsWith('/happy-hours')) {
    return { rules: [{ weekdays: [1], start: '10:00', end: '12:00', discountPercent: 50 }] };
  }
  if (p.endsWith('/appointments/:appointmentId/coupons')) {
    return { version: 1, couponId: currentIds?.couponId };
  }
  if (p.endsWith('/loyalty/earn-rules')) {
    return { rules: [{ serviceId: currentIds?.serviceId, points: 1000 }] };
  }
  if (p.endsWith('/appointments')) {
    return { ...appointmentBody(), allowOutsideHours: true };
  }
  if (p.endsWith('/working-hours/overrides/:date')) {
    return { intervals: [{ start: '09:00', end: '10:00' }] };
  }
  if (p.endsWith('/working-hours')) return { days: [] };
  if (p.endsWith('/time-off')) return { start: `${DATE}T09:00`, end: `${DATE}T10:00` };
  if (p.endsWith('/services/:serviceId/staff')) return { staffIds: [] };
  if (p.endsWith('/staff/order')) return { staffIds: [currentIds?.staffId] };
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
  if (path.endsWith('/availability')) {
    return `${path}?serviceId=${ids.serviceId}&from=${DATE}&to=${DATE}`;
  }
  if (
    ['/appointments', '/time-blocks', '/calendar', '/reports', '/visits-csv'].some((end) =>
      path.endsWith(end),
    )
  ) {
    return `${path}?from=${DATE}&to=${DATE}`;
  }
  return path;
}

/** Body for creating an appointment; ids filled in per request by `send`. */
let currentIds: Ids | undefined;
function appointmentBody(): object {
  return {
    serviceId: currentIds?.serviceId,
    staffId: currentIds?.staffId,
    start: '2027-01-11T12:00:00.000Z',
    customer: { name: 'Hacker', phone: '+48500000000' },
  };
}

/** Pictures are sent as they are (image/png), everything else as JSON. */
function withType(req: ReturnType<ReturnType<TestContext['http']>['post']>, body: object) {
  return Buffer.isBuffer(body) ? req.set('Content-Type', 'image/png').send(body) : req.send(body);
}

function send(route: Route, url: string, user: SignedInUser) {
  const agent = ctx.http();
  switch (route.method) {
    case 'get':
      return agent.get(url).set(user.auth);
    case 'delete':
      return agent.delete(url).set(user.auth);
    case 'post':
      return withType(agent.post(url).set(user.auth), validBody(route));
    case 'patch':
      return agent.patch(url).set(user.auth).send(validBody(route));
    case 'put':
      return withType(agent.put(url).set(user.auth), validBody(route));
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
  const serviceCategory = await ctx
    .http()
    .post(`${base}/service-categories`)
    .set(user.auth)
    .send({ name: 'Włosy' })
    .expect(201);
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(user.auth)
    .send({
      name: 'Strzyżenie',
      durationMinutes: 30,
      priceGrosze: 6000,
      categoryId: serviceCategory.body.id,
      color: '#3366FF',
    })
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
  const appointment = await ctx
    .http()
    .post(`${base}/appointments`)
    .set(user.auth)
    .send({
      serviceId: service.body.id,
      staffId: staff.body.id,
      start: APPOINTMENT_START,
      customer: { name: 'Jan Kowalski', phone: '+48600100200', email: 'jan@example.com' },
    })
    .expect(201);
  const series = await ctx
    .http()
    .post(`${base}/time-blocks/series`)
    .set(user.auth)
    .send({
      staffId: staff.body.id,
      start: '2027-01-19T08:00:00.000Z',
      end: '2027-01-19T09:00:00.000Z',
      weeks: 2,
    })
    .expect(201);
  const block = await ctx
    .http()
    .post(`${base}/time-blocks`)
    .set(user.auth)
    .send({
      staffId: staff.body.id,
      start: '2027-01-12T08:00:00.000Z',
      end: '2027-01-12T09:00:00.000Z',
      reason: 'Szkolenie',
    })
    .expect(201);
  const category = await ctx
    .http()
    .post(`/v1/organizations/${org.orgId}/staff-categories`)
    .set(user.auth)
    .send({ name: 'Senior', permissions: { viewClientContacts: true } })
    .expect(201);
  const staffUser = await ctx.prisma.user.create({
    data: { email: `staff-${org.orgId}@example.com`, passwordHash: 'not-used', name: 'Staff' },
  });
  const membership = await ctx.prisma.membership.create({
    data: {
      userId: staffUser.id,
      organizationId: org.orgId,
      role: 'staff',
      staffCategoryId: category.body.id,
      locations: { create: [{ locationId: org.locationId }] },
    },
  });
  const invitation = await ctx
    .http()
    .post(`/v1/organizations/${org.orgId}/invitations`)
    .set(user.auth)
    .send({
      email: `invited-${org.orgId}@example.com`,
      role: 'staff',
      locationIds: [org.locationId],
    })
    .expect(201);
  const photo = await ctx
    .http()
    .post(`${base}/photos`)
    .set(user.auth)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(201);
  await ctx
    .http()
    .put(`${staffUrl}/photo`)
    .set(user.auth)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(200);
  await ctx
    .http()
    .put(`/v1/organizations/${org.orgId}/loyalty/program`)
    .set(user.auth)
    .send({
      version: 0,
      enabled: true,
      mode: 'stamps',
      stampsPerVisit: 1,
      pointsPerUnit: 0,
      spendUnitGrosze: 10000,
      minSpendGrosze: 0,
      pointsValidityDays: null,
      maxDiscountPercent: 50,
      allowStacking: false,
      marketplaceEnabled: false,
    })
    .expect(200);
  await ctx
    .http()
    .put(`${base}/loyalty/earn-rules`)
    .set(user.auth)
    .send({ rules: [{ serviceId: service.body.id, points: 2 }] })
    .expect(200);
  const loyalty = `/v1/organizations/${org.orgId}/loyalty`;
  const customerId = appointment.body.customer.id;
  const reward = await ctx
    .http()
    .post(`${loyalty}/rewards`)
    .set(user.auth)
    .send({ name: '−10%', kind: 'discount_percent', discountPercent: 10, cost: 2 })
    .expect(201);
  await ctx
    .http()
    .post(`${loyalty}/accounts/${customerId}/adjustments`)
    .set(user.auth)
    .send({ points: 5, reason: 'Start' })
    .expect(201);
  const coupon = await ctx
    .http()
    .post(`${loyalty}/accounts/${customerId}/redemptions`)
    .set(user.auth)
    .send({ rewardId: reward.body.id })
    .expect(201);
  // A client waiting for a free time (task 50c).
  const entry = await ctx.prisma.waitlistEntry.create({
    data: {
      locationId: org.locationId,
      serviceId: service.body.id,
      date: new Date(`${DATE}T00:00:00.000Z`),
      name: 'Waiting Client',
      email: `waiting-${org.orgId}@example.com`,
      tokenHash: `isolation-${org.orgId}`,
    },
  });
  return {
    orgId: org.orgId,
    locationId: org.locationId,
    serviceId: service.body.id,
    staffId: staff.body.id,
    timeOffId: timeOff.body.id,
    date: DATE,
    appointmentId: appointment.body.id,
    customerId: appointment.body.customer.id,
    categoryId: category.body.id,
    membershipId: membership.id,
    blockId: block.body.id,
    seriesId: series.body.seriesId,
    serviceCategoryId: serviceCategory.body.id,
    invitationId: invitation.body.id,
    photoId: photo.body.id,
    rewardId: reward.body.id,
    couponId: coupon.body.id,
    entryId: entry.id,
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
    appointments: await ctx.prisma.appointment.findMany({
      where: { locationId: ids.locationId },
      include: { events: true },
    }),
    customers: await ctx.prisma.customer.findMany({ where: { organizationId: ids.orgId } }),
    staffCategories: await ctx.prisma.staffCategory.findMany({
      where: { organizationId: ids.orgId },
    }),
    memberships: await ctx.prisma.membership.findMany({ where: { organizationId: ids.orgId } }),
    timeBlocks: await ctx.prisma.timeBlock.findMany({ where: { locationId: ids.locationId } }),
    serviceCategories: await ctx.prisma.serviceCategory.findMany({
      where: { locationId: ids.locationId },
    }),
    invitations: await ctx.prisma.invitation.findMany({ where: { organizationId: ids.orgId } }),
    loyalty: await ctx.prisma.loyaltyProgram.findMany({
      where: { organizationId: ids.orgId },
      include: {
        earnRules: true,
        rewards: true,
        accounts: { include: { transactions: true, coupons: true } },
      },
    }),
    photos: await ctx.prisma.photo.findMany({
      where: { locationId: ids.locationId },
      select: { id: true, staffId: true, sizeBytes: true },
      orderBy: { id: 'asc' },
    }),
    waitlist: await ctx.prisma.waitlistEntry.findMany({ where: { locationId: ids.locationId } }),
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
      applies: (r) =>
        /:(serviceId|staffId|appointmentId|customerId|categoryId|membershipId|blockId|seriesId|serviceCategoryId|invitationId|photoId|rewardId|couponId|entryId)/.test(
          r.path,
        ) || r.path.endsWith('/availability'),
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
        currentIds = scenario.ids();
        const res = await send(route, urlFor(route, currentIds), alice);
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

  it("cannot put own service into another location's category", async () => {
    const res = await ctx
      .http()
      .patch(
        `/v1/organizations/${aliceIds.orgId}/locations/${aliceIds.locationId}/services/${aliceIds.serviceId}`,
      )
      .set(alice.auth)
      .send({ version: 1, categoryId: bobIds.serviceCategoryId })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("cannot invite into another organization's location or staff profile", async () => {
    const url = `/v1/organizations/${aliceIds.orgId}/invitations`;
    const other = await ctx
      .http()
      .post(url)
      .set(alice.auth)
      .send({ email: 'x1@example.com', role: 'staff', locationIds: [bobIds.locationId] })
      .expect(400);
    expect(other.body.error.code).toBe('VALIDATION_ERROR');
    const profile = await ctx
      .http()
      .post(url)
      .set(alice.auth)
      .send({
        email: 'x2@example.com',
        role: 'staff',
        locationIds: [aliceIds.locationId],
        staffMemberId: bobIds.staffId,
      })
      .expect(400);
    expect(profile.body.error.code).toBe('VALIDATION_ERROR');
  });
});
