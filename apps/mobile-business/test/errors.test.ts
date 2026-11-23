import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { errorText } from '../src/errors';
import { DICTIONARIES, LOCALES } from '../src/i18n';

describe.each(LOCALES)('error messages in %s', (locale) => {
  const t = DICTIONARIES[locale];

  it('explains rate limiting', () => {
    expect(errorText(new ApiError(429, 'Internal message'), t)).toBe(t.error.tooMany);
  });

  it('uses a localized fallback for other API errors', () => {
    expect(errorText(new ApiError(500, 'Internal message'), t)).toBe(t.error.generic);
  });

  it('explains a failed network request', () => {
    expect(errorText(new TypeError('Failed to fetch'), t)).toBe(t.error.network);
  });
});
