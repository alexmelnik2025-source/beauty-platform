import { Platform } from 'react-native';

/**
 * Address of the API. Set EXPO_PUBLIC_API_URL when building for phones (there is no server
 * yet — see docs/DEPLOY.md). The web preview is served next to the API, so it uses the same
 * address; a phone simulator on this computer reaches the API at localhost:4000.
 */
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? '' : 'http://localhost:4000');
