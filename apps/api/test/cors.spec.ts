import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/config';
import { createTestApp, type TestContext } from './helpers';

/**
 * Owner's test 05.11.2026: the client app in the browser (`pnpm mobile:client --web`,
 * http://localhost:8081) said "no connection to the server" — the API sent no CORS headers.
 * Development allows any page; production only the origins in CORS_ORIGINS.
 */

const PREVIEW = 'http://localhost:8081';
const LAN = 'http://192.168.1.20:8082';

let dev: TestContext;
let prod: TestContext;
let none: TestContext;

beforeAll(async () => {
  dev = await createTestApp({ cors: 'any' });
  prod = await createTestApp({ cors: ['https://partner.example.com'] });
  none = await createTestApp();
});

afterAll(async () => {
  await Promise.all([dev.app.close(), prod.app.close(), none.app.close()]);
});

describe('CORS', () => {
  it('development: the phone apps in the browser may call the API with a Bearer token', async () => {
    for (const origin of [PREVIEW, LAN]) {
      const preflight = await dev
        .http()
        .options('/v1/client/me')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key');
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      expect(preflight.headers['access-control-allow-headers']).toBe(
        'authorization,content-type,idempotency-key',
      );
      expect(preflight.headers['access-control-allow-methods']).toContain('PATCH');
    }
    const health = await dev.http().get('/v1/health').set('Origin', PREVIEW);
    expect(health.headers['access-control-allow-origin']).toBe(PREVIEW);
    expect(health.headers['access-control-expose-headers']).toContain('Retry-After');
    // No cookies across sites: the apps use the Bearer token.
    expect(health.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('production: only the listed origins', async () => {
    const allowed = await prod
      .http()
      .get('/v1/health')
      .set('Origin', 'https://partner.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://partner.example.com');
    const other = await prod.http().get('/v1/health').set('Origin', PREVIEW);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('without settings there are no CORS headers (the web app is on the same address)', async () => {
    const res = await none.http().get('/v1/health').set('Origin', PREVIEW);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS_ORIGINS setting', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    JWT_ACCESS_SECRET: 'x'.repeat(40),
    NODE_ENV: 'test',
  };

  it('is empty by default and takes a comma-separated list', () => {
    expect(parseConfig(base).CORS_ORIGINS).toEqual([]);
    expect(
      parseConfig({ ...base, CORS_ORIGINS: 'https://a.example.com/, http://localhost:8081' })
        .CORS_ORIGINS,
    ).toEqual(['https://a.example.com', 'http://localhost:8081']);
  });

  it('refuses something that is not a web address', () => {
    expect(() => parseConfig({ ...base, CORS_ORIGINS: 'example.com' })).toThrow();
  });
});
