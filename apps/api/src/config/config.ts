import { existsSync } from 'node:fs';
import { z } from 'zod';
import { parseMailbox } from '../mail/compose';

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
    /**
     * Number of proxies in front of the API whose X-Forwarded-For can be trusted
     * (the web server passes /v1 on, so 1 behind it). 0 = use the direct address.
     * Rate limits per IP depend on this.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
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
    SMTP_URL: z.string().default('smtp://127.0.0.1:1025'),
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
    /**
     * Push messages to installed apps and browsers. webpush = real Web Push (needs the VAPID
     * keys below, otherwise push is off); memory = kept in memory, for tests.
     */
    PUSH_TRANSPORT: z.enum(['webpush', 'memory']).default('webpush'),
    /** VAPID key pair (base64url). Generate: node scripts/vapid-keys.mjs */
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    /** Contact for push services: mailto: or https: address of the platform. */
    VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),
    /**
     * One-time codes by SMS. none = no SMS gateway, clients get codes by email only;
     * log = local development, the text goes to the API log; memory = tests.
     * A real (paid) Polish SMS gateway is connected only after the owner decides.
     */
    SMS_TRANSPORT: z.enum(['none', 'log', 'memory']).default('none'),
    /**
     * Other sites (origins) whose pages may call the API from the browser, comma-separated,
     * e.g. https://app.example.com. Empty = only the platform's own web app (same address, no
     * CORS). In development any origin is allowed (phone apps in the browser, a Mac's LAN IP).
     */
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim().replace(/\/+$/, ''))
          .filter(Boolean),
      )
      .pipe(z.array(z.url({ protocol: /^https?$/ }))),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && config.MAIL_TRANSPORT === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'memory is not allowed in production',
      });
    }
    if (config.NODE_ENV === 'production' && config.PUSH_TRANSPORT === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['PUSH_TRANSPORT'],
        message: 'memory is not allowed in production',
      });
    }
    if (config.NODE_ENV === 'production' && config.SMS_TRANSPORT !== 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_TRANSPORT'],
        message: `${config.SMS_TRANSPORT} is not allowed in production`,
      });
    }
    // Launch task L2: links in emails must open for clients, and mail must come from a real domain.
    if (config.NODE_ENV === 'production') {
      const web = parseUrl(config.APP_WEB_URL);
      if (!web || web.protocol !== 'https:' || isLocalHost(web.hostname)) {
        ctx.addIssue({
          code: 'custom',
          path: ['APP_WEB_URL'],
          message: 'must be the public https:// address in production (links in emails use it)',
        });
      }
      const from = parseMailbox(config.MAIL_FROM).address;
      const domain = from.split('@')[1] ?? '';
      if (!from.includes('@') || isLocalHost(domain)) {
        ctx.addIssue({
          code: 'custom',
          path: ['MAIL_FROM'],
          message:
            'must be an address on your domain in production, e.g. Salon <rezerwacje@example.pl>',
        });
      }
    }
    if (Boolean(config.VAPID_PUBLIC_KEY) !== Boolean(config.VAPID_PRIVATE_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAPID_PRIVATE_KEY'],
        message: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set together',
      });
    }
    if (config.MAIL_TRANSPORT === 'resend' && !config.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'required when MAIL_TRANSPORT=resend',
      });
    }
  })
  .transform((config) =>
    config.NODE_ENV === 'development'
      ? { ...config, DATABASE_URL: preferIpv4Loopback(config.DATABASE_URL) }
      : config,
  );

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host)
  );
}

/**
 * Local development: "localhost" may resolve to IPv6 (::1) first — on a Mac every new
 * database connection then waits before falling back to 127.0.0.1, where Docker publishes
 * PostgreSQL (docker-compose.yml). Owner's test 03.11.2026: signed-in requests took 2–10 s.
 */
export function preferIpv4Loopback(url: string): string {
  return url.replace(
    /^(postgres(?:ql)?:\/\/(?:[^@/]*@)?)localhost(?=[:/?]|$)/,
    (_, prefix: string) => `${prefix}127.0.0.1`,
  );
}

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
