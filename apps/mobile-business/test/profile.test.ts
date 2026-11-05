import { describe, expect, it } from 'vitest';
import { BusinessApi, type TokenStore } from '../src/api';
import { flags, languagesChanged, toggleLanguage } from '../src/profile';

describe('the specialist’s languages', () => {
  it('turns a language on and off, keeping the order clients see', () => {
    expect(toggleLanguage(['en'], 'pl')).toEqual(['pl', 'en']);
    expect(toggleLanguage(['pl', 'en'], 'pl')).toEqual(['en']);
    expect(toggleLanguage([], 'be')).toEqual(['be']);
  });

  it('knows when there is something to save', () => {
    expect(languagesChanged(['pl', 'en'], ['en', 'pl'])).toBe(false);
    expect(languagesChanged(['pl'], ['pl', 'uk'])).toBe(true);
    expect(languagesChanged(['pl'], [])).toBe(true);
  });

  it('shows flags in the clients’ order', () => {
    expect(flags(['en', 'pl'])).toBe('🇵🇱 🇬🇧');
    expect(flags([])).toBe('');
  });
});

describe('BusinessApi languages', () => {
  it('sets the languages of a specialist', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a9', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : { id: 's1', languages: ['pl', 'en'] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.setStaffLanguages('o1', 'l1', 's1', ['pl', 'en']);
    expect(calls.slice(1)).toEqual([
      {
        key: 'PUT /v1/organizations/o1/locations/l1/staff/s1/languages',
        body: { languages: ['pl', 'en'] },
      },
    ]);
  });
});
