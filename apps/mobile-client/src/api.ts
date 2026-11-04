import type {
  Availability,
  ClientAppointment,
  ClientAppointmentList,
  ClientCodeSent,
  ClientLoyalty,
  ClientLoyaltyCard,
  ClientPerson,
  ClientSignIn,
  PublicLocation,
  PublicSalonDirectory,
  Slot,
} from '@beauty/api-client';

/**
 * The client app's connection to the API: sign-in with an emailed code (no password, no
 * account to create) and "My visits" in every salon. No React Native imports here, so the
 * same code is tested with Vitest (test/api.test.ts).
 */

export type Locale = 'pl' | 'uk' | 'ru' | 'en';
export type Scope = 'upcoming' | 'past';
/** Languages a salon or specialist can speak with clients (Belarusian too). */
export type SpokenLanguage = PublicSalonDirectory['items'][number]['languages'][number];
export type DirectorySalon = PublicSalonDirectory['items'][number];
export type { Availability, PublicLocation, PublicSalonDirectory, Slot };

/** "Change time" looks this many days ahead (the API gives at most 31 days per request). */
export const MOVE_DAYS = 21;

/** The catalogue shows this many salons at a time (the API allows up to 50). */
export const PAGE_SIZE = 20;

/** The web booking page of a salon (booking inside the app comes in a later part). */
export function bookingUrl(webUrl: string, locale: Locale, slug: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${locale}/b/${encodeURIComponent(slug)}`;
}
/**
 * "Book again": the web booking page that starts with the same service and specialist.
 * null when the salon no longer takes this service online.
 */
export function bookAgainUrl(
  webUrl: string,
  locale: Locale,
  visit: ClientAppointment,
): string | null {
  if (!visit.bookAgain) return null;
  const params = new URLSearchParams({ service: visit.bookAgain.serviceId });
  if (visit.bookAgain.staffId) params.set('staff', visit.bookAgain.staffId);
  return `${bookingUrl(webUrl, locale, visit.bookAgain.slug)}?${params.toString()}`;
}

/** The local date YYYY-MM-DD `days` days after `date` (calendar days, no time zone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today's date in the salon's time zone (not the phone's): free times start from it. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A fresh Idempotency-Key: a second tap (or a retry after a lost answer) does the change once. */
export function newRequestKey(): string {
  const uuid = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.();
  if (uuid) return uuid;
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export type {
  ClientAppointment,
  ClientAppointmentList,
  ClientCodeSent,
  ClientLoyalty,
  ClientLoyaltyCard,
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

  /** One of my visits, as it is now (status, whether it can still be changed online). */
  appointment(id: string): Promise<ClientAppointment> {
    return this.authed<ClientAppointment>(
      'GET',
      `/v1/client/appointments/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Cancels a visit (until the salon's deadline — otherwise TOO_LATE_TO_CHANGE).
   * One key per tap of "Yes": a repeated request does not cancel twice.
   */
  cancel(id: string, key: string = newRequestKey()): Promise<ClientAppointment> {
    return this.authed<ClientAppointment>(
      'POST',
      `/v1/client/appointments/${encodeURIComponent(id)}/cancel`,
      {},
      { 'idempotency-key': key },
    );
  }

  /**
   * Free times of the visit's specialist for the same service, `days` days from `from`
   * (the salon's local date). Public: the same answer the booking page gets.
   */
  freeTimes(
    visit: ClientAppointment,
    from: string,
    days: number = MOVE_DAYS,
  ): Promise<Availability> {
    const params = new URLSearchParams({
      serviceId: visit.service.id,
      staffId: visit.staff.id,
      from,
      to: addDays(from, days - 1),
    });
    return this.call<Availability>(
      'GET',
      `/v1/public/locations/${encodeURIComponent(visit.salon.slug)}/availability?${params.toString()}`,
    );
  }

  /**
   * Moves a visit to a free time (`start` of a slot from freeTimes), with the same specialist.
   * Until the salon's deadline — otherwise TOO_LATE_TO_CHANGE; a time taken meanwhile — SLOT_TAKEN.
   */
  reschedule(id: string, start: string, key: string = newRequestKey()): Promise<ClientAppointment> {
    return this.authed<ClientAppointment>(
      'POST',
      `/v1/client/appointments/${encodeURIComponent(id)}/reschedule`,
      { start },
      { 'idempotency-key': key },
    );
  }

  /**
   * "My bonuses": stamps or points in every salon where the client has a loyalty card, the
   * rewards, coupons to show at the salon and the history (never the salon's notes).
   */
  loyalty(): Promise<ClientLoyalty> {
    return this.authed<ClientLoyalty>('GET', '/v1/client/loyalty');
  }

  /** Salons open for online booking; `language` — spoken by the salon or one of its staff. No sign-in. */
  directory(
    query: { page?: number; language?: SpokenLanguage } = {},
  ): Promise<PublicSalonDirectory> {
    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      pageSize: String(PAGE_SIZE),
    });
    if (query.language) params.set('language', query.language);
    return this.call<PublicSalonDirectory>('GET', `/v1/public/locations?${params.toString()}`);
  }

  /** A salon's page: address, description, hours, price list, specialists. No sign-in. */
  salon(slug: string): Promise<PublicLocation> {
    return this.call<PublicLocation>('GET', `/v1/public/locations/${encodeURIComponent(slug)}`);
  }

  private async forget(): Promise<void> {
    this.token = null;
    await this.store.set(null);
  }

  /** A signed-in call; a session the server no longer accepts signs out on this phone. */
  private async authed<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (!this.token) throw new ApiError(401, 'Not signed in');
    try {
      return await this.call<T>(method, path, body, this.token, extraHeaders);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) await this.forget();
      throw error;
    }
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
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
