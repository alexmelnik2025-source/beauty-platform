import { afterEach, describe, expect, it, vi } from 'vitest';

const { platform, secure } = vi.hoisted(() => ({
  platform: { OS: 'web' },
  secure: { getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() },
}));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-secure-store', () => secure);

const key = 'beauty.client.session';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.resetModules();
});

describe('client token storage', () => {
  it('stores, reads and removes the token in the browser', async () => {
    platform.OS = 'web';
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => values.set(name, value),
      removeItem: (name: string) => values.delete(name),
    });
    const { tokenStore } = await import('../src/storage');

    expect(await tokenStore.get()).toBeNull();
    await tokenStore.set('sample-token');
    expect(values.get(key)).toBe('sample-token');
    expect(await tokenStore.get()).toBe('sample-token');
    await tokenStore.set(null);
    expect(await tokenStore.get()).toBeNull();
    expect(secure.setItemAsync).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'blocked'])('tolerates %s browser storage', async (mode) => {
    platform.OS = 'web';
    const blocked = () => {
      throw new Error('Storage blocked');
    };
    vi.stubGlobal(
      'localStorage',
      mode === 'blocked' ? { getItem: blocked, setItem: blocked, removeItem: blocked } : undefined,
    );
    const { tokenStore } = await import('../src/storage');

    await expect(tokenStore.get()).resolves.toBeNull();
    await expect(tokenStore.set('sample-token')).resolves.toBeUndefined();
    await expect(tokenStore.set(null)).resolves.toBeUndefined();
  });

  it('uses secure storage for native reads, writes and deletes', async () => {
    platform.OS = 'ios';
    secure.getItemAsync.mockResolvedValue('sample-token');
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
    const { tokenStore } = await import('../src/storage');

    await expect(tokenStore.get()).resolves.toBe('sample-token');
    await tokenStore.set('new-token');
    await tokenStore.set(null);
    expect(secure.getItemAsync).toHaveBeenCalledWith(key);
    expect(secure.setItemAsync).toHaveBeenCalledWith(key, 'new-token');
    expect(secure.deleteItemAsync).toHaveBeenCalledWith(key);
    expect(globalThis.localStorage.getItem).not.toHaveBeenCalled();
    expect(globalThis.localStorage.setItem).not.toHaveBeenCalled();
    expect(globalThis.localStorage.removeItem).not.toHaveBeenCalled();
  });
});

describe.each(['web', 'android'])('catalog storage on %s', (os) => {
  const languagesKey = 'beauty.catalog.languages';
  const recentKey = 'beauty.catalog.recent';
  const salon = { slug: 'gestalt', name: 'Салон' };

  async function setup(values = new Map<string, string>()) {
    platform.OS = os;
    const read = (name: string) => values.get(name) ?? null;
    const write = (name: string, value: string) => {
      values.set(name, value);
    };
    vi.stubGlobal('localStorage', os === 'web' ? { getItem: read, setItem: write } : undefined);
    if (os !== 'web') {
      secure.getItemAsync.mockImplementation(read);
      secure.setItemAsync.mockImplementation(write);
    }
    return import('../src/storage');
  }

  it('round-trips the languages and recent salons under separate keys', async () => {
    const values = new Map<string, string>();
    const { catalogLanguagesStore, recentSalonsStore } = await setup(values);

    expect(await catalogLanguagesStore.get()).toEqual([]);
    expect(await recentSalonsStore.get()).toEqual([]);
    await catalogLanguagesStore.set(['pl', 'uk']);
    await recentSalonsStore.set([salon]);
    expect(values.get(languagesKey)).toBe(JSON.stringify(['pl', 'uk']));
    expect(values.get(recentKey)).toBe(JSON.stringify([salon]));
    expect(await catalogLanguagesStore.get()).toEqual(['pl', 'uk']);
    expect(await recentSalonsStore.get()).toEqual([salon]);
  });

  it.each(['', '{bad json', '{"unexpected":true}'])(
    'ignores invalid stored data %j',
    async (raw) => {
      const { catalogLanguagesStore, recentSalonsStore } = await setup(
        new Map([
          [languagesKey, raw],
          [recentKey, raw],
        ]),
      );

      expect(await catalogLanguagesStore.get()).toEqual([]);
      expect(await recentSalonsStore.get()).toEqual([]);
    },
  );

  it('keeps valid entries from partially invalid arrays', async () => {
    const { catalogLanguagesStore, recentSalonsStore } = await setup(
      new Map([
        [languagesKey, JSON.stringify(['pl', null, 42, 'uk'])],
        [
          recentKey,
          JSON.stringify([null, salon, { slug: '', name: 'Invalid' }, { slug: 'other' }]),
        ],
      ]),
    );

    expect(await catalogLanguagesStore.get()).toEqual(['pl', 'uk']);
    expect(await recentSalonsStore.get()).toEqual([salon]);
  });

  it('falls back to empty lists after storage failures', async () => {
    const { catalogLanguagesStore, recentSalonsStore } = await setup();
    const error = new Error('Storage blocked');
    if (os === 'web') {
      const blocked = () => {
        throw error;
      };
      vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    } else {
      secure.getItemAsync.mockRejectedValue(error);
      secure.setItemAsync.mockRejectedValue(error);
    }

    await expect(catalogLanguagesStore.get()).resolves.toEqual([]);
    await expect(recentSalonsStore.get()).resolves.toEqual([]);
    await expect(catalogLanguagesStore.set(['pl'])).resolves.toBeUndefined();
    await expect(recentSalonsStore.set([salon])).resolves.toBeUndefined();
  });
});
