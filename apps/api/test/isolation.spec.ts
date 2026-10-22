import { RequestMethod } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/**
 * Tenant isolation: a user of organization A calls EVERY organization-scoped
 * endpoint with organization B's ids. Routes are discovered automatically, so a
 * new endpoint is covered without anyone remembering to add it here.
 */

interface Route {
  method: string;
  path: string;
}

// Nest's own metadata keys (PATH_METADATA / METHOD_METADATA).
const PATH = 'path';
const METHOD = 'method';

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

function send(method: string, url: string, user: SignedInUser) {
  const agent = ctx.http();
  const body = { name: 'Hacked', version: 1 };
  switch (method) {
    case 'get':
      return agent.get(url).set(user.auth);
    case 'delete':
      return agent.delete(url).set(user.auth);
    case 'post':
      return agent.post(url).set(user.auth).send(body);
    case 'patch':
      return agent.patch(url).set(user.auth).send(body);
    case 'put':
      return agent.put(url).set(user.auth).send(body);
    default:
      throw new Error(`isolation.spec.ts: unsupported method ${method}`);
  }
}

let ctx: TestContext;
let alice: SignedInUser;
let bobOrg: { orgId: string; locationId: string };

beforeAll(async () => {
  ctx = await createTestApp();
  await resetState(ctx);
  alice = await signUp(ctx, 'alice@example.com');
  await createOrgWithLocation(ctx, alice, 'Alice Salon');
  const bob = await signUp(ctx, 'bob@example.com');
  bobOrg = await createOrgWithLocation(ctx, bob, 'Bob Barber');
});

afterAll(async () => {
  await ctx.app.close();
});

describe('tenant isolation', () => {
  const scoped = () => discoverRoutes(ctx).filter((r) => r.path.includes(':orgId'));

  it('finds the organization-scoped endpoints', () => {
    const routes = scoped();
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });

  it("returns 404 for every endpoint called with another organization's ids and changes nothing", async () => {
    const before = await ctx.prisma.location.findUniqueOrThrow({
      where: { id: bobOrg.locationId },
    });
    const orgBefore = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: bobOrg.orgId },
    });

    for (const route of scoped()) {
      const url = route.path.replace(/:(\w+)/g, (_, param: string) => {
        if (param === 'orgId') return bobOrg.orgId;
        if (param === 'locationId') return bobOrg.locationId;
        throw new Error(
          `isolation.spec.ts: add an id of organization B for ":${param}" (${route.path})`,
        );
      });
      const res = await send(route.method, url, alice);
      expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBe(404);
      expect(res.body.error?.code, `${route.method.toUpperCase()} ${route.path}`).toBe('NOT_FOUND');
    }

    const after = await ctx.prisma.location.findUniqueOrThrow({ where: { id: bobOrg.locationId } });
    const orgAfter = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: bobOrg.orgId },
    });
    expect(after).toEqual(before);
    expect(orgAfter).toEqual(orgBefore);
  });

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
});
