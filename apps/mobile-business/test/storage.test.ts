import { afterEach, describe, expect, it, vi } from 'vitest';

const { platform, secure } = vi.hoisted(() => ({
  platform: { OS: 'web' },
  secure: { getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() },
}));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-secure-store', () => secure);

const key = 'beauty.business.refreshToken';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.resetModules();
});

describe('business token storage', () => {
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

  it('can retry a failed write over an existing plain-text token', async () => {
    platform.OS = 'web';
    const values = new Map([[key, 'existing-token']]);
    const setItem = vi.fn((name: string, value: string) => values.set(name, value));
    setItem.mockImplementationOnce(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError');
    });
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => values.get(name) ?? null,
      setItem,
    });
    const { tokenStore } = await import('../src/storage');

    await tokenStore.set('replacement-token');
    expect(setItem).toHaveBeenCalledWith(key, 'replacement-token');
    expect(await tokenStore.get()).toBe('existing-token');
    await tokenStore.set('replacement-token');
    expect(await tokenStore.get()).toBe('replacement-token');
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
