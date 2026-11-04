import type {
  ClientAppointment,
  ClientAppointmentList,
  ClientCodeSent,
  ClientPerson,
  ClientSignIn,
} from '@beauty/api-client';

/**
 * The client app's connection to the API: sign-in with an emailed code (no password, no
 * account to create) and "My visits" in every salon. No React Native imports here, so the
 * same code is tested with Vitest (test/api.test.ts).
 */

export type Locale = 'pl' | 'uk' | 'ru' | 'en';
export type Scope = 'upcoming' | 'past';
export type {
  ClientAppointment,
  ClientAppointmentList,
  ClientCodeSent,
  ClientPerson,
  ClientSignIn,
};

/** Where the session token lives: Keychain/Keystore on phones, browser storage in the web preview. */
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

/** The email the client typed, cleaned up; null when it is not an email address. */
export function parseEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class ClientApi {
  private token: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly store: TokenStore,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
  ) {}

  get signedIn(): boolean {
    return this.token !== null;
  }

  /** Emails a 6-digit code. Always accepted, whether or not the address has visits. */
  requestCode(email: string, locale: Locale): Promise<ClientCodeSent> {
    return this.call<ClientCodeSent>('POST', '/v1/client/auth/code', { email, locale });
  }

  /** Signs in; the session token (90 days) is kept on the phone. */
  async verifyCode(email: string, code: string, locale: Locale): Promise<ClientPerson> {
    const res = await this.call<ClientSignIn>('POST', '/v1/client/auth/verify', {
      email,
      code,
      locale,
      clientType: 'mobile',
    });
    if (!res.token) throw new ApiError(500, 'No session token in the answer');
    this.token = res.token;
    await this.store.set(res.token);
    return res.person;
  }

  /**
   * On app start: the saved session, if the server still accepts it.
   * null = show the sign-in screen (nothing saved, or the session has ended).
   */
  async restore(): Promise<ClientPerson | null> {
    this.token = await this.store.get();
    if (!this.token) return null;
    try {
      return await this.me();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  async signOut(): Promise<void> {
    try {
      if (this.token) await this.authed<void>('POST', '/v1/client/auth/logout');
    } catch {
      // Signed out on this phone in any case; the session ends on the server when it expires.
    }
    await this.forget();
  }

  me(): Promise<ClientPerson> {
    return this.authed<ClientPerson>('GET', '/v1/client/me');
  }

  /** The language of the app is also the language of the salon's emails to this client. */
  setLocale(locale: Locale): Promise<ClientPerson> {
    return this.authed<ClientPerson>('PATCH', '/v1/client/me', { locale });
  }

  /** Visits in all salons: upcoming (soonest first) or past (latest 50). */
  appointments(scope: Scope): Promise<ClientAppointmentList> {
    return this.authed<ClientAppointmentList>('GET', `/v1/client/appointments?scope=${scope}`);
  }

  private async forget(): Promise<void> {
    this.token = null;
    await this.store.set(null);
  }

  /** A signed-in call; a session the server no longer accepts signs out on this phone. */
  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new ApiError(401, 'Not signed in');
    try {
      return await this.call<T>(method, path, body, this.token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) await this.forget();
      throw error;
    }
  }

  private async call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
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
