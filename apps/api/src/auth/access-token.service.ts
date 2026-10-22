import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { AuthContext } from '../common/request-context';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = 'beauty-platform';
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

interface Claims {
  iss: string;
  sub: string;
  sid: string;
  iat: number;
  exp: number;
}

/**
 * Short-lived access tokens (JWT, HS256). Implemented on node:crypto to avoid
 * a dependency; only the fixed header is accepted, so "alg" tricks do not apply.
 */
@Injectable()
export class AccessTokenService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(config.JWT_ACCESS_SECRET, 'utf8');
  }

  sign(context: AuthContext, now = Date.now()): string {
    const iat = Math.floor(now / 1000);
    const claims: Claims = {
      iss: ISSUER,
      sub: context.userId,
      sid: context.sessionId,
      iat,
      exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${HEADER}.${payload}.${this.signature(`${HEADER}.${payload}`)}`;
  }

  /** Returns the auth context, or null for any invalid, tampered or expired token. */
  verify(token: string, now = Date.now()): AuthContext | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    if (header !== HEADER) return null;

    const expected = Buffer.from(this.signature(`${header}.${payload}`));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    let claims: Partial<Claims>;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Claims>;
    } catch {
      return null;
    }
    if (
      claims.iss !== ISSUER ||
      typeof claims.sub !== 'string' ||
      typeof claims.sid !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= Math.floor(now / 1000)
    ) {
      return null;
    }
    return { userId: claims.sub, sessionId: claims.sid };
  }

  private signature(input: string): string {
    return createHmac('sha256', this.key).update(input).digest('base64url');
  }
}
