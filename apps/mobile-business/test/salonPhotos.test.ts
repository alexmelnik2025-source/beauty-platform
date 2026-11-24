import { describe, expect, it } from 'vitest';
import { ApiError, BusinessApi, type TokenStore } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import { photosLeft, photoType, uploadErrorText } from '../src/salonPhotos';

const t = DICTIONARIES.pl;

describe('salon photos from the phone (task 337)', () => {
  it('sends the types the API takes, anything else as JPEG', () => {
    expect(photoType('image/png', '')).toBe('image/png');
    expect(photoType(null, 'image/webp')).toBe('image/webp');
    expect(photoType('image/heic', 'image/heic')).toBe('image/jpeg');
    expect(photoType(undefined, '')).toBe('image/jpeg');
  });

  it('counts how many still fit (10 per salon)', () => {
    expect(photosLeft(0)).toBe(10);
    expect(photosLeft(7)).toBe(3);
    expect(photosLeft(9)).toBe(1);
    expect(photosLeft(10)).toBe(0);
    expect(photosLeft(11)).toBe(0);
    expect(photosLeft(12)).toBe(0);
  });

  it('never offers more than ten places for a negative count', () => {
    expect(photosLeft(-1)).toBe(10);
  });

  it('explains a refused photo', () => {
    expect(uploadErrorText(new ApiError(409, 'x', 'TOO_MANY_PHOTOS'), t)).toBe(t.salon.photosFull);
    expect(uploadErrorText(new ApiError(413, 'x', 'PHOTO_TOO_LARGE'), t)).toBe(
      t.salon.photoTooLarge,
    );
    expect(uploadErrorText(new ApiError(415, 'x', 'UNSUPPORTED_PHOTO'), t)).toBe(
      t.salon.photoBadType,
    );
    expect(uploadErrorText(new ApiError(500, 'x'), t)).toBeNull();
    expect(uploadErrorText(new Error('offline'), t)).toBeNull();
  });
});

describe('BusinessApi: a salon photo', () => {
  it('keeps the gallery in server order and regains all ten places after the last deletion', async () => {
    const path = '/v1/organizations/o1/locations/l1/photos';
    const photo = (id: string, createdAt: string) => ({
      id,
      createdAt,
      url: `/v1/public/photos/${id}`,
      contentType: 'image/jpeg',
      sizeBytes: 1000,
    });
    const older = photo('z', '2026-11-08T09:00:00Z');
    const newer = photo('a', '2026-11-09T09:00:00Z');
    const gallery = new Map([
      [older.id, older],
      [newer.id, newer],
    ]);
    const fetchFn = async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      if (init?.method === 'POST' && pathname === '/v1/auth/refresh') {
        return Response.json({ accessToken: 'a1', expiresIn: 900 });
      }
      if (init?.method === 'GET' && pathname === path) return Response.json([...gallery.values()]);
      if (
        init?.method === 'DELETE' &&
        pathname.startsWith(path + '/') &&
        gallery.delete(pathname.slice(path.length + 1))
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init?.method} ${pathname}`);
    };
    const api = new BusinessApi(
      'https://api.test',
      { get: async () => 'refresh', set: async () => undefined },
      fetchFn,
    );
    await api.restore();
    expect(await api.salonPhotos('o1', 'l1')).toEqual([older, newer]);
    await api.removeSalonPhoto('o1', 'l1', older.id);
    expect(await api.salonPhotos('o1', 'l1')).toEqual([newer]);
    await api.removeSalonPhoto('o1', 'l1', newer.id);
    const empty = await api.salonPhotos('o1', 'l1');
    expect(empty).toEqual([]);
    expect(photosLeft(empty.length)).toBe(10);
  });

  it('sends the picture itself with its type, signed in, and retries after a refresh', async () => {
    const calls: {
      key: string;
      type: string | undefined;
      auth: string | undefined;
      body: unknown;
    }[] = [];
    let refused = false;
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        key,
        type: headers['content-type'],
        auth: headers.authorization,
        body: init?.body,
      });
      if (key.startsWith('POST /v1/auth/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: `a${calls.length}`,
            expiresIn: 900,
            refreshToken: 'refresh-token-0123456789new',
          }),
        );
      }
      if (!refused) {
        refused = true;
        return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'x' } }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({
          id: 'p1',
          url: '/v1/public/photos/p1',
          contentType: 'image/png',
          sizeBytes: 3,
          createdAt: '2026-11-08T15:00:00.000Z',
        }),
        { status: 201 },
      );
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    const photo = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const saved = await api.addSalonPhoto('o1', 'l1', photo, 'image/png');
    expect(saved.id).toBe('p1');
    const uploads = calls.filter((c) => c.key === 'POST /v1/organizations/o1/locations/l1/photos');
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.type).toBe('image/png');
      expect(upload.body).toBe(photo);
    }
    // The second try goes with the new token.
    expect(uploads[0]!.auth).not.toBe(uploads[1]!.auth);
  });
});

describe('BusinessApi: a specialist’s photo (task 339)', () => {
  it('puts the picture itself and removes it', async () => {
    const calls: { key: string; type: string | undefined; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ key, type: headers['content-type'], body: init?.body });
      if (key.startsWith('POST /v1/auth/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: 'a1',
            expiresIn: 900,
            refreshToken: 'refresh-token-0123456789new',
          }),
        );
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          id: 'p2',
          url: '/v1/public/photos/p2',
          contentType: 'image/jpeg',
          sizeBytes: 3,
          createdAt: '2026-11-08T15:00:00.000Z',
        }),
      );
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    const photo = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    expect((await api.setStaffPhoto('o1', 'l1', 's1', photo, 'image/jpeg')).id).toBe('p2');
    await api.removeStaffPhoto('o1', 'l1', 's1');
    const path = '/v1/organizations/o1/locations/l1/staff/s1/photo';
    expect(calls.slice(1)).toEqual([
      { key: `PUT ${path}`, type: 'image/jpeg', body: photo },
      { key: `DELETE ${path}`, type: undefined, body: undefined },
    ]);
  });
});
