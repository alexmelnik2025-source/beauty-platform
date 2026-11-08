import { describe, expect, it } from 'vitest';
import { ApiError, BusinessApi, type CustomerExport, type TokenStore } from '../src/api';
import { eraseErrorText, exportFileName, exportText, shareExport } from '../src/clientPrivacy';
import { DICTIONARIES } from '../src/i18n';

const t = DICTIONARIES.pl;

const data = {
  exportedAt: '2026-11-08T15:00:00.000Z',
  salon: { name: 'GESTALT' },
  client: {
    id: 'c1',
    name: 'Jan Kowalski',
    phone: '+48600100200',
    email: null,
    language: 'pl',
    note: null,
    tags: [],
    birthday: null,
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  consents: [],
  visits: [],
  loyalty: [],
} as CustomerExport;

describe('the client’s data (task 334)', () => {
  it('names the file like the server and writes readable JSON', () => {
    expect(exportFileName('c1')).toBe('client-c1.json');
    const text = exportText(data);
    expect(text).toContain('\n  "salon": {\n    "name": "GESTALT"\n  },');
    expect(JSON.parse(text)).toEqual(data);
  });

  it('the browser saves the file; a phone shares its text', async () => {
    const saved: { fileName: string; text: string }[] = [];
    expect(
      await shareExport('c1', data, {
        download: (fileName, text) => saved.push({ fileName, text }),
      }),
    ).toBe('downloaded');
    expect(saved).toEqual([{ fileName: 'client-c1.json', text: exportText(data) }]);

    const sent: { title: string; message: string }[] = [];
    expect(
      await shareExport('c1', data, {
        native: async (c) => {
          sent.push(c);
          return { action: 'sharedAction' };
        },
      }),
    ).toBe('shared');
    expect(sent[0]?.title).toBe('client-c1.json');
    expect(JSON.parse(sent[0]!.message)).toEqual(data);
  });

  it('explains why erasing was refused', () => {
    expect(
      eraseErrorText(
        new ApiError(409, 'x', 'CUSTOMER_HAS_UPCOMING_VISITS', [
          { path: 'upcoming', message: '2' },
        ]),
        t,
      ),
    ).toBe(`${t.clientPrivacy.upcoming} (2)`);
    expect(eraseErrorText(new ApiError(409, 'x', 'CUSTOMER_ANONYMIZED'), t)).toBe(
      t.clientPrivacy.already,
    );
    expect(eraseErrorText(new ApiError(409, 'x', 'VERSION_CONFLICT'), t)).toBe(t.clients.conflict);
    expect(eraseErrorText(new ApiError(403, 'x', 'FORBIDDEN'), t)).toBe(t.clientPrivacy.ownerOnly);
    expect(eraseErrorText(new ApiError(500, 'x'), t)).toBeNull();
    expect(eraseErrorText(new Error('offline'), t)).toBeNull();
  });

  it('has the texts in all four languages', () => {
    for (const dict of Object.values(DICTIONARIES)) {
      expect(Object.keys(dict.clientPrivacy)).toEqual(Object.keys(t.clientPrivacy));
    }
  });
});

describe('BusinessApi: the client’s data', () => {
  it('downloads the data and erases them with the version that was read', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (key.startsWith('POST /v1/auth/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: 'a9',
            expiresIn: 900,
            refreshToken: 'refresh-token-0123456789new',
          }),
        );
      }
      if (key.endsWith('/anonymize')) {
        return new Response(
          JSON.stringify({ id: 'c1', anonymizedAt: '2026-11-08T15:00:00.000Z', visitsKept: 3 }),
        );
      }
      return new Response(JSON.stringify(data));
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    expect(await api.exportCustomer('o1', 'c1')).toEqual(data);
    expect((await api.anonymizeCustomer('o1', 'c1', 7)).visitsKept).toBe(3);
    expect(calls.slice(1)).toEqual([
      { key: 'GET /v1/organizations/o1/customers/c1/export', body: undefined },
      { key: 'POST /v1/organizations/o1/customers/c1/anonymize', body: { version: 7 } },
    ]);
  });
});
