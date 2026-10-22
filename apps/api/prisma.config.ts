import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env by itself. Load it when present (local development);
// in CI the variables come from the environment.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Not needed for `prisma generate`; required for migrations.
    url: process.env.DATABASE_URL ?? '',
  },
});
