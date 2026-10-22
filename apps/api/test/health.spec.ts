import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

async function createApp(prismaOverride?: unknown): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (prismaOverride) {
    builder = builder.overrideProvider(PrismaService).useValue(prismaOverride);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, { docs: true });
  await app.init();
  return app;
}

describe('GET /v1/health with a real database', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 without signing in and reports the database as up', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'up' } });
    expect(Date.parse(res.body.time)).not.toBeNaN();
  });

  it('adds a request id to every response', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it('keeps a valid request id sent by the client', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/health')
      .set('x-request-id', 'mobile-app-123456');
    expect(res.headers['x-request-id']).toBe('mobile-app-123456');
  });

  it('answers unknown routes in the standard error format', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/does-not-exist')
      .set('Authorization', 'Bearer x');
    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('does not reveal the server technology', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('publishes the OpenAPI document', async () => {
    const res = await request(app.getHttpServer()).get('/v1/docs-json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/v1/auth/login', '/v1/organizations/{orgId}/locations']),
    );
  });
});

describe('GET /v1/health when the database is unreachable', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const brokenPrisma = {
      $queryRaw: () => Promise.reject(new Error('connection refused')),
      $disconnect: () => Promise.resolve(),
    };
    app = await createApp(brokenPrisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 and reports the database as down', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(503);
    expect(res.body).toMatchObject({ status: 'error', checks: { database: 'down' } });
  });
});
