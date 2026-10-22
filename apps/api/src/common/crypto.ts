import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Sent to the user; never stored as-is. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored as SHA-256 hashes, so a database leak does not expose usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
