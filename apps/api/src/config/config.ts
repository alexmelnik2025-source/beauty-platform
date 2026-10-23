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
    /**
     * smtp = SMTP server (Mailpit locally); resend = Resend HTTP API (refuses duplicates by
     * idempotency key); memory = kept in memory, for tests.
     */
    MAIL_TRANSPORT: z.enum(['smtp', 'resend', 'memory']).default('smtp'),
    RESEND_API_KEY: z.string().optional(),
    RESEND_API_URL: z.url().default('https://api.resend.com'),
    SMTP_URL: z.string().default('smtp://localhost:1025'),
    MAIL_FROM: z.string().default('Beauty Platform <no-reply@localhost>'),
    /** How often the email queue is checked, ms. 0 = background worker off (tests drain it by hand). */
    OUTBOX_POLL_MS: z.coerce.number().int().min(0).max(600_000).default(2000),
    /** Emails of platform administrators (comma-separated): email queue page and alerts. */
    PLATFORM_ADMIN_EMAILS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    /** Alert when a due email has waited longer than this, minutes. */
    OUTBOX_ALERT_AFTER_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && config.MAIL_TRANSPORT === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'memory is not allowed in production',
      });
    }
    if (config.MAIL_TRANSPORT === 'resend' && !config.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'required when MAIL_TRANSPORT=resend',
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
