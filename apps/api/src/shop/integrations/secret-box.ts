import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';

/**
 * Task Q4: encrypts the sellers' tokens of their own systems (Base) before they are stored.
 * AES-256-GCM with a key derived (HKDF-SHA256) from INTEGRATIONS_SECRET, or from
 * JWT_ACCESS_SECRET while that is not set. Stored as "v1.<iv>.<tag>.<ciphertext>" (base64url).
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const secret = config.INTEGRATIONS_SECRET ?? config.JWT_ACCESS_SECRET;
    this.key = Buffer.from(
      hkdfSync('sha256', secret, 'beauty-platform', 'shop-integrations-v1', 32),
    );
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, tag, body]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  /** null = sealed with another key (the secret changed) or damaged: the seller connects again. */
  open(sealed: string): string | null {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || body === undefined) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
