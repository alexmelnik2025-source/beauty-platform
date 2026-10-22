import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config/config';

const valid = { DATABASE_URL: 'postgresql://user:secret-password@localhost:5432/db' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(valid)).toMatchObject({ NODE_ENV: 'development', PORT: 4000 });
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-PostgreSQL URL', () => {
    expect(() => parseConfig({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
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
