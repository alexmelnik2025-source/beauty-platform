import { describe, expect, it } from 'vitest';
import { BusinessApi, type TokenStore } from '../src/api';
import { flags, languagesChanged, SPOKEN, toggleLanguage } from '../src/profile';

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

  it('can clear the last language and leave an already empty profile unchanged', () => {
    const cleared = toggleLanguage(['uk'], 'uk');
    expect(cleared).toEqual([]);
    expect(languagesChanged(['uk'], cleared)).toBe(true);
    expect(languagesChanged([], cleared)).toBe(false);
  });

  it('labels Ukrainian as UA and selects it with the API code uk', () => {
    const ukrainian = SPOKEN.find((language) => language.code === 'uk')!;
    expect(ukrainian.name).toBe('UA · Українська');
    const chosen = toggleLanguage([], ukrainian.code);
    expect(chosen).toEqual(['uk']);
    expect(flags(chosen)).toBe('🇺🇦');
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
        : { id: 's1', languages: ['pl', 'uk'] };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.setStaffLanguages('o1', 'l1', 's1', ['pl', 'uk']);
    expect(calls.slice(1)).toEqual([
      {
        key: 'PUT /v1/organizations/o1/locations/l1/staff/s1/languages',
        body: { languages: ['pl', 'uk'] },
      },
    ]);
  });
});
