import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { TokenStore } from './api';

const KEY = 'beauty.business.refreshToken';

/**
 * The refresh token: in the iPhone Keychain / Android Keystore. The web preview (used by the
 * e2e test for screenshots) has no Keychain, so it keeps the token in the browser instead.
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
            // Private mode: the person signs in again next time.
          }
        },
      }
    : {
        get: () => SecureStore.getItemAsync(KEY),
        set: (value) =>
          value ? SecureStore.setItemAsync(KEY, value) : SecureStore.deleteItemAsync(KEY),
      };
