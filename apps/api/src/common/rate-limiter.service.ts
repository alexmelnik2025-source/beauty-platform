import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from './app-exception';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter kept in memory. Enough for a single API instance (MVP);
 * when the API runs on several instances this moves to PostgreSQL.
 */
@Injectable()
export class RateLimiterService {
  private readonly windows = new Map<string, Window>();

  /** Throws 429 RATE_LIMITED when `key` exceeded `limit` hits within `windowMs`. */
  hit(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      this.cleanup(now);
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        `Too many attempts. Try again in ${retryAfterSeconds} seconds`,
      );
    }
  }

  reset(): void {
    this.windows.clear();
  }

  private cleanup(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
