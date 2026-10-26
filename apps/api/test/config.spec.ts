import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config/config';

const valid = {
  DATABASE_URL: 'postgresql://user:secret-password@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a-test-secret-that-is-long-enough-0123',
};

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(valid)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      MAIL_TRANSPORT: 'smtp',
    });
  });

  it('requires a long enough token signing secret', () => {
    expect(() => parseConfig({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('refuses in-memory email in production', () => {
    expect(() =>
      parseConfig({ ...valid, NODE_ENV: 'production', MAIL_TRANSPORT: 'memory' }),
    ).toThrow(/MAIL_TRANSPORT/);
  });

  it('SMS: off by default; the log and memory transports are refused in production', () => {
    expect(parseConfig(valid).SMS_TRANSPORT).toBe('none');
    expect(() => parseConfig({ ...valid, NODE_ENV: 'production', SMS_TRANSPORT: 'log' })).toThrow(
      /SMS_TRANSPORT/,
    );
    expect(() =>
      parseConfig({ ...valid, NODE_ENV: 'production', SMS_TRANSPORT: 'memory' }),
    ).toThrow(/SMS_TRANSPORT/);
    expect(parseConfig({ ...valid, SMS_TRANSPORT: 'log' }).SMS_TRANSPORT).toBe('log');
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => parseConfig({ JWT_ACCESS_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(ConfigError);
    expect(() => parseConfig({ JWT_ACCESS_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a non-PostgreSQL URL', () => {
    expect(() => parseConfig({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an invalid port', () => {
    expect(() => parseConfig({ ...valid, PORT: '99999' })).toThrow(/PORT/);
  });

  it('never includes secret values in the error message', () => {
    try {
      parseConfig({ ...valid, PORT: 'not-a-number', NODE_ENV: 'staging' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  });
});
