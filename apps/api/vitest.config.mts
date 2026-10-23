import { existsSync } from 'node:fs';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Tests always run against the separate test database, never the development one.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('Set TEST_DATABASE_URL (see apps/api/.env.example) before running tests');
}

export default defineConfig({
  // SWC keeps decorator metadata, which NestJS dependency injection needs.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      JWT_ACCESS_SECRET:
        process.env.JWT_ACCESS_SECRET ?? 'test-only-secret-not-used-anywhere-else-012345',
      // Tests read emails from memory instead of sending them.
      MAIL_TRANSPORT: 'memory',
      // Tests run the email queue explicitly instead of on a timer.
      OUTBOX_POLL_MS: '0',
      PLATFORM_ADMIN_EMAILS: 'admin@example.com',
    },
    // One shared test database: run test files one after another.
    fileParallelism: false,
  },
});
