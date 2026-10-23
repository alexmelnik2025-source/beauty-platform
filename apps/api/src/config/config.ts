import { existsSync } from 'node:fs';
import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'must be a PostgreSQL connection URL',
  });

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: postgresUrl,
    /** HMAC key for access tokens. Generate: openssl rand -base64 48 */
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    /** Base URL of the owner web app; used in links inside emails. */
    APP_WEB_URL: z.url().default('http://localhost:3000'),
    /** smtp = real sending (Mailpit locally); memory = kept in memory, for tests. */
    MAIL_TRANSPORT: z.enum(['smtp', 'memory']).default('smtp'),
    SMTP_URL: z.string().default('smtp://localhost:1025'),
    MAIL_FROM: z.string().default('Beauty Platform <no-reply@localhost>'),
    /** How often the email queue is checked, ms. 0 = background worker off (tests drain it by hand). */
    OUTBOX_POLL_MS: z.coerce.number().int().min(0).max(600_000).default(2000),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && config.MAIL_TRANSPORT === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'memory is not allowed in production',
      });
    }
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
