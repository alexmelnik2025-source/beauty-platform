import type { Calendar, Location, LoginCodeSent, Me, Tokens, components } from '@beauty/api-client';

/**
 * The business app's connection to the API: sign-in with a code (no password),
 * the signed-in user's salons and the day calendar. No React Native imports here,
 * so the same code is tested with Vitest (test/api.test.ts).
 */

export type Locale = 'pl' | 'uk' | 'ru' | 'en';
export type LocationList = components['schemas']['LocationList'];
export type { Calendar, Location, LoginCodeSent, Me, Tokens };

/** Where the refresh token lives: Keychain/Keystore on phones, browser storage in the web preview. */
export interface TokenStore {
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Contact = { email: string } | { phone: string };

/**
 * What the person typed on the sign-in screen: an email, or a phone number.
 * Nine digits without a country code are a Polish number (+48).
 */
export function parseContact(input: string): Contact | null {
  const value = input.trim();
  if (value.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { email: value.toLowerCase() } : null;
  }
  const phone = value.replace(/[\s()-]/g, '');
  if (/^\d{9}$/.test(phone)) return { phone: `+48${phone}` };
  if (/^00[1-9]\d{6,14}$/.test(phone)) return { phone: `+${phone.slice(2)}` };
  return /^\+[1-9]\d{6,14}$/.test(phone) ? { phone } : null;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class BusinessApi {
  private accessToken: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly store: TokenStore,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
    private readonly deviceName = 'Business app',
  ) {}

  get signedIn(): boolean {
    return this.accessToken !== null;
  }

  /** Sends a 6-digit code to the email, or for a phone number by SMS (or to the invitation's email). */
  requestCode(contact: Contact, locale: Locale): Promise<LoginCodeSent> {
    return this.call<LoginCodeSent>('POST', '/v1/auth/code', { ...contact, locale });
  }

  /** Signs in; an invited person gets their account and salon role on the first sign-in. */
  async verifyCode(contact: Contact, code: string, locale: Locale): Promise<Tokens> {
    const tokens = await this.call<Tokens>('POST', '/v1/auth/code/verify', {
      ...contact,
      code,
      locale,
      clientType: 'mobile',
      deviceName: this.deviceName,
    });
    await this.keep(tokens);
    return tokens;
  }

  /** On app start: signs in again with the saved refresh token. False = show the sign-in screen. */
  async restore(): Promise<boolean> {
    return this.refresh();
  }

  async signOut(): Promise<void> {
    try {
      if (this.accessToken) await this.call<void>('POST', '/v1/auth/logout', undefined, true);
    } catch {
      // Signed out on this phone in any case; the session ends on the server when it expires.
    }
    this.accessToken = null;
    await this.store.set(null);
  }

  me(): Promise<Me> {
    return this.authed<Me>('GET', '/v1/me');
  }

  /** Salons (locations) of the organization the person may open. */
  locations(orgId: string): Promise<LocationList> {
    return this.authed<LocationList>('GET', `/v1/organizations/${enc(orgId)}/locations`);
  }

  /** One day of the calendar; a specialist sees only what the server lets them see. */
  calendar(orgId: string, locationId: string, date: string): Promise<Calendar> {
    const query = new URLSearchParams({ from: date, to: date }).toString();
    return this.authed<Calendar>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/calendar?${query}`,
    );
  }

  private async keep(tokens: Tokens): Promise<void> {
    this.accessToken = tokens.accessToken;
    if (tokens.refreshToken) await this.store.set(tokens.refreshToken);
  }

  private async refresh(): Promise<boolean> {
    const refreshToken = await this.store.get();
    if (!refreshToken) return false;
    try {
      await this.keep(await this.call<Tokens>('POST', '/v1/auth/refresh', { refreshToken }));
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.accessToken = null;
        await this.store.set(null);
        return false;
      }
      throw error;
    }
  }

  /** A signed-in call; an expired access token is renewed once and the call repeated. */
  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.accessToken && !(await this.refresh())) throw new ApiError(401, 'Not signed in');
    try {
      return await this.call<T>(method, path, body, true);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      if (!(await this.refresh())) throw error;
      return this.call<T>(method, path, body, true);
    }
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      // The API answers errors as { error: { code, message, requestId } }.
      const error = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new ApiError(
        res.status,
        typeof error?.message === 'string' ? error.message : `HTTP ${res.status}`,
        typeof error?.code === 'string' ? error.code : undefined,
      );
    }
    return data as T;
  }
}

const enc = encodeURIComponent;
