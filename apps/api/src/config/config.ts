import { existsSync } from 'node:fs';
import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
      message: 'must be a PostgreSQL connection URL',
    }),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

/**
 * Validates environment variables. Fails fast with the names of invalid
 * variables (never their values, which may be secrets).
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration — ${problems}`);
  }
  return result.data;
}

/** Loads .env (if present) without overriding variables already set, then validates. */
export function loadConfig(): AppConfig {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  return parseConfig(process.env);
}
