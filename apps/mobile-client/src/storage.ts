import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { TokenStore } from './api';

const KEY = 'beauty.client.session';

/**
 * The client's session token (90 days): in the iPhone Keychain / Android Keystore. The web
 * preview (used by the e2e test for screenshots) has no Keychain, so it keeps it in the browser.
 */
export const tokenStore: TokenStore =
  Platform.OS === 'web'
    ? {
        async get() {
          try {
            return globalThis.localStorage?.getItem(KEY) ?? null;
          } catch {
            return null;
          }
        },
        async set(value) {
          try {
            if (value) globalThis.localStorage?.setItem(KEY, value);
            else globalThis.localStorage?.removeItem(KEY);
          } catch {
            // Private mode: the client signs in again next time.
          }
        },
      }
    : {
        get: () => SecureStore.getItemAsync(KEY),
        set: (value) =>
          value ? SecureStore.setItemAsync(KEY, value) : SecureStore.deleteItemAsync(KEY),
      };

const LANGUAGES_KEY = 'beauty.catalog.languages';

/** Task 192: the languages chosen in the catalogue last time, kept on this device. */
export const catalogLanguagesStore = {
  async get(): Promise<string[]> {
    try {
      const raw =
        Platform.OS === 'web'
          ? (globalThis.localStorage?.getItem(LANGUAGES_KEY) ?? null)
          : await SecureStore.getItemAsync(LANGUAGES_KEY);
      const saved: unknown = JSON.parse(raw ?? '[]');
      return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  },
  async set(codes: string[]): Promise<void> {
    try {
      const value = JSON.stringify(codes);
      if (Platform.OS === 'web') globalThis.localStorage?.setItem(LANGUAGES_KEY, value);
      else await SecureStore.setItemAsync(LANGUAGES_KEY, value);
    } catch {
      // Private mode or no storage: the choice is just not remembered.
    }
  },
};
