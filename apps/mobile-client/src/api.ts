import type {
  Availability,
  BookingConfirmed,
  CodeSent,
  Hold,
  ClientAppointment,
  ClientAppointmentList,
  ClientCodeSent,
  ClientDataExport,
  ClientFavorites,
  ClientLoyalty,
  ClientLoyaltyCard,
  ClientPerson,
  ClientSignIn,
  ClientVisitSummary,
  ClientWaitlist,
  ClientWaitlistEntry,
  PublicFreeToday,
  PublicLocation,
  PublicReviews,
  PublicSalonDirectory,
  Slot,
  VisitCoupons,
  VisitPhoto,
  VisitPhotoList,
  VisitReview,
  WaitlistJoined,
} from '@beauty/api-client';

/**
 * The client app's connection to the API: sign-in with an emailed code (no password, no
 * account to create) and "My visits" in every salon. No React Native imports here, so the
 * same code is tested with Vitest (test/api.test.ts).
 */

/** pl, uk, ru, en, tr (Turkish), sq (Albanian) — the same list as the API. */
export type Locale = 'pl' | 'uk' | 'ru' | 'en' | 'tr' | 'sq';
export type Scope = 'upcoming' | 'past';
/** Languages a salon or specialist can speak with clients (Belarusian too). */
export type SpokenLanguage = PublicSalonDirectory['items'][number]['languages'][number];
export type DirectorySalon = PublicSalonDirectory['items'][number];
export type Specialty = DirectorySalon['specialties'][number];
export type FavoriteSalon = ClientFavorites['items'][number];
export type {
  ClientDataExport,
  ClientWaitlist,
  ClientWaitlistEntry,
  VisitPhoto,
  VisitPhotoList,
  VisitReview,
  WaitlistJoined,
};
export type {
  Availability,
  BookingConfirmed,
  ClientFavorites,
  CodeSent,
  Hold,
  PublicFreeToday,
  PublicLocation,
  PublicReviews,
  PublicSalonDirectory,
  Slot,
};

/** Contact details the booking asks for (the same form as the web booking page). */
export interface BookingContact {
  name: string;
  /** E.164, e.g. +48600100200 (see normalizePhone in src/phone.ts). */
  phone: string;
  email: string;
  acceptTerms: true;
  marketingConsent: boolean;
}

/** "Change time" looks this many days ahead (the API gives at most 31 days per request). */
export const MOVE_DAYS = 21;

/** Task 80f: at most this many example photos per visit (the API checks it too). */
export const MAX_WISH_PHOTOS = 3;

/** The catalogue shows this many salons at a time (the API allows up to 50). */
export const PAGE_SIZE = 20;

/** The web booking page of a salon (the app books inside itself; this is for sharing). */
export function bookingUrl(webUrl: string, locale: Locale, slug: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${locale}/b/${encodeURIComponent(slug)}`;
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

/** The name of the "Download my data" file, as on the site: my-data-YYYY-MM-DD.json. */
export function myDataFileName(data: Pick<ClientDataExport, 'exportedAt'>): string {
  return `my-data-${data.exportedAt.slice(0, 10)}.json`;
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
  VisitCoupons,
  ClientCodeSent,
  ClientLoyalty,
  ClientLoyaltyCard,
  ClientPerson,
  ClientSignIn,
  ClientVisitSummary,
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

  /**
   * Task 97 — "Download my data" (GDPR access and portability, as on the site): everything the
   * salons keep about the signed-in client, found by the confirmed email.
   */
  exportData(): Promise<ClientDataExport> {
    return this.authed<ClientDataExport>('GET', '/v1/client/export');
  }

  /** Task 293: "Twoje wizyty" — visits that took place in every salon and what they cost. */
  visitSummary(): Promise<ClientVisitSummary> {
    return this.authed<ClientVisitSummary>('GET', '/v1/client/me/summary');
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

  /** My coupons in the visit's salon: the ones used on it, and the others with what each takes off. */
  visitCoupons(id: string): Promise<VisitCoupons> {
    return this.authed<VisitCoupons>(
      'GET',
      `/v1/client/appointments/${encodeURIComponent(id)}/coupons`,
    );
  }

  /** Uses one of my coupons on an upcoming visit (until the salon's deadline). */
  useCoupon(id: string, couponId: string): Promise<ClientAppointment> {
    return this.authed<ClientAppointment>(
      'POST',
      `/v1/client/appointments/${encodeURIComponent(id)}/coupons`,
      { couponId },
    );
  }

  /** Takes a coupon off an upcoming visit; it can be used again. */
  dropCoupon(id: string, couponId: string): Promise<ClientAppointment> {
    return this.authed<ClientAppointment>(
      'POST',
      `/v1/client/appointments/${encodeURIComponent(id)}/coupons/${encodeURIComponent(couponId)}/remove`,
    );
  }

  /**
   * Cancels a visit (until the salon's deadline — otherwise TOO_LATE_TO_CHANGE).
   * One key per tap of "Yes": a repeated request does not cancel twice.
   */
  /** Task 22: a link to the visit as an .ics file; opening it adds the visit to the calendar. */
  calendarLink(id: string): Promise<{ url: string }> {
    return this.authed<{ url: string }>(
      'POST',
      `/v1/client/appointments/${encodeURIComponent(id)}/calendar-link`,
      {},
    );
  }

  /** Task 80: the visit's wishes, until the visit starts (VISIT_NOT_CHANGEABLE after). */
  updateWishes(id: string, wishes: ClientAppointment['wishes']): Promise<ClientAppointment> {
    return this.authed<ClientAppointment>(
      'PUT',
      `/v1/client/appointments/${encodeURIComponent(id)}/wishes`,
      wishes,
    );
  }

  /** Task 165b: my review of the visit and whether I can (still) write or change it. */
  visitReview(id: string): Promise<VisitReview> {
    return this.authed<VisitReview>(
      'GET',
      `/v1/client/appointments/${encodeURIComponent(id)}/review`,
    );
  }

  /** Task 165b: 1–5 stars and optional words (REVIEW_NOT_POSSIBLE when it is no longer possible). */
  writeReview(id: string, rating: number, text: string): Promise<VisitReview> {
    return this.authed<VisitReview>(
      'PUT',
      `/v1/client/appointments/${encodeURIComponent(id)}/review`,
      { rating, text },
    );
  }

  /** Task 80j: my example photos for the visit and when they are deleted. */
  visitPhotos(id: string): Promise<VisitPhotoList> {
    return this.authed<VisitPhotoList>(
      'GET',
      `/v1/client/appointments/${encodeURIComponent(id)}/photos`,
    );
  }

  /** Task 80j: removes one of my photos, until the visit starts (TOO_LATE_TO_CHANGE after). */
  removeVisitPhoto(id: string, photoId: string): Promise<void> {
    return this.authed<void>(
      'DELETE',
      `/v1/client/appointments/${encodeURIComponent(id)}/photos/${encodeURIComponent(photoId)}`,
    );
  }

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

  /** Free times of a salon for a service (`staffId` omitted = any specialist). Public. */
  availability(
    slug: string,
    query: {
      serviceId: string;
      staffId?: string;
      /** Task 70c: "any of these" — the specialists of one price line (ignored with staffId). */
      staffIds?: string[];
      from: string;
      to: string;
    },
  ): Promise<Availability> {
    const params = new URLSearchParams({
      serviceId: query.serviceId,
      from: query.from,
      to: query.to,
    });
    if (query.staffId) params.set('staffId', query.staffId);
    else if (query.staffIds?.length) params.set('staffIds', query.staffIds.join(','));
    return this.call<Availability>(
      'GET',
      `/v1/public/locations/${encodeURIComponent(slug)}/availability?${params.toString()}`,
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

  /**
   * Booking, step 1: holds a free time for 10 minutes. `staffId` omitted = any specialist.
   * A previous hold of this booking is released (`releaseHoldToken`). No sign-in needed.
   */
  hold(
    slug: string,
    input: {
      serviceId: string;
      staffId?: string;
      staffIds?: string[];
      start: string;
      releaseHoldToken?: string;
    },
    key: string = newRequestKey(),
  ): Promise<Hold> {
    return this.call<Hold>(
      'POST',
      `/v1/public/locations/${encodeURIComponent(slug)}/holds`,
      input,
      undefined,
      { 'idempotency-key': key },
    );
  }

  /** Booking, step 2: contact details; a 6-digit code goes to the email (again = resend). */
  sendBookingCode(hold: Hold, contact: BookingContact, locale: Locale): Promise<CodeSent> {
    return this.call<CodeSent>('POST', `/v1/public/holds/${encodeURIComponent(hold.holdId)}/code`, {
      holdToken: hold.holdToken,
      ...contact,
      locale,
      codeChannel: 'email',
    });
  }

  /**
   * Booking, step 3: the code from the email books the visit. The same code twice (a lost
   * answer, a second tap) books once: the key is the hold and the code, as on the web.
   */
  confirmBooking(
    hold: Hold,
    code: string,
    /** Task 80: only when the salon asks (see wishesToSend). */
    wishes?: ClientAppointment['wishes'],
  ): Promise<BookingConfirmed> {
    return this.call<BookingConfirmed>(
      'POST',
      `/v1/public/holds/${encodeURIComponent(hold.holdId)}/confirm`,
      { holdToken: hold.holdToken, code, ...(wishes ? { wishes } : {}) },
      undefined,
      { 'idempotency-key': `confirm-${hold.holdId}-${code}` },
    );
  }

  /**
   * Task 180e: signed in - the held time is booked without a code; the email is the session's.
   * Once per hold (a lost answer, a second tap), like the code step.
   */
  confirmBookingSignedIn(
    hold: Hold,
    contact: Omit<BookingContact, 'email'>,
    locale: Locale,
    wishes?: ClientAppointment['wishes'],
  ): Promise<BookingConfirmed> {
    return this.authed<BookingConfirmed>(
      'POST',
      `/v1/client/holds/${encodeURIComponent(hold.holdId)}/confirm`,
      { holdToken: hold.holdToken, ...contact, locale, ...(wishes ? { wishes } : {}) },
      { 'idempotency-key': `confirm-signed-in-${hold.holdId}` },
    );
  }

  /**
   * Task 80f: "Pokaż, co chcesz" — one example photo added to the held time (JPEG, PNG or
   * WebP, at most 3 MB); it stays with the visit once it is booked. Only for services where
   * the salon asks for photos (PHOTOS_NOT_ASKED otherwise), at most 3 (TOO_MANY_PHOTOS).
   */
  async addHoldPhoto(hold: Hold, photo: Blob, contentType: string): Promise<VisitPhoto> {
    const res = await this.fetchFn(
      `${this.baseUrl}/v1/public/holds/${encodeURIComponent(hold.holdId)}/photos`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': contentType,
          'x-hold-token': hold.holdToken,
        },
        body: photo,
      },
    );
    return this.answer<VisitPhoto>(res);
  }

  /** Takes an example photo off the held time. */
  removeHoldPhoto(hold: Hold, photoId: string): Promise<void> {
    return this.call<void>(
      'DELETE',
      `/v1/public/holds/${encodeURIComponent(hold.holdId)}/photos/${encodeURIComponent(photoId)}`,
      undefined,
      undefined,
      { 'x-hold-token': hold.holdToken },
    );
  }

  /** Gives a held time back (the client left the booking). Errors do not matter. */
  async releaseHold(hold: Hold): Promise<void> {
    try {
      await this.call<void>('POST', `/v1/public/holds/${encodeURIComponent(hold.holdId)}/release`, {
        holdToken: hold.holdToken,
      });
    } catch {
      // The hold ends by itself after 10 minutes.
    }
  }

  /** Salons open for online booking; `language` — spoken by the salon or one of its staff. No sign-in. */
  directory(
    query: {
      page?: number;
      /** Task 192: several = salons speaking any of them. */
      language?: SpokenLanguage[];
      /** Task 160: kind of place (what one of its specialists does). */
      specialty?: Specialty;
      /** Task 180b: "Czego szukasz?" — a service or the salon's name, a city or street. */
      q?: string;
      /** Task 180b: "W pobliżu" — the nearest salons first, with `distanceKm`. */
      near?: { latitude: number; longitude: number };
      /** Task 365: "Otwarte teraz" — only salons open right now. */
      openNow?: boolean;
      /** Task 378: "Najlepiej oceniane" — the salons with the best stars first. */
      bestRated?: boolean;
      /** Task 401: "Inne salony w pobliżu" — the salons nearest to this salon (slug), without it. */
      nearSalon?: string;
      pageSize?: number;
    } = {},
  ): Promise<PublicSalonDirectory> {
    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      pageSize: String(query.pageSize ?? PAGE_SIZE),
    });
    if (query.language?.length) params.set('language', query.language.join(','));
    if (query.specialty) params.set('specialty', query.specialty);
    if (query.q?.trim()) params.set('q', query.q.trim());
    if (query.openNow) params.set('openNow', 'true');
    if (query.bestRated) params.set('sort', 'rating');
    if (query.nearSalon) params.set('nearSalon', query.nearSalon);
    if (query.near) {
      const { latitude, longitude } = query.near;
      params.set('near', `${latitude.toFixed(4)},${longitude.toFixed(4)}`);
    }
    return this.call<PublicSalonDirectory>('GET', `/v1/public/locations?${params.toString()}`);
  }

  /** A salon's page: address, description, hours, price list, specialists. No sign-in. */
  salon(slug: string): Promise<PublicLocation> {
    return this.call<PublicLocation>('GET', `/v1/public/locations/${encodeURIComponent(slug)}`);
  }

  /**
   * Task 212: reviews on the salon page, newest first, 20 at a time (165b; the salon's answers —
   * 211). No sign-in and no client data. `enabled: false` while the salon does not collect them.
   */
  salonReviews(
    slug: string,
    query: { staffId?: string; before?: string; rating?: number } = {},
  ): Promise<PublicReviews> {
    const params = new URLSearchParams();
    if (query.staffId) params.set('staffId', query.staffId);
    // Task 381: only the reviews with this many stars.
    if (query.rating) params.set('rating', String(query.rating));
    if (query.before) params.set('before', query.before);
    const q = params.toString();
    return this.call<PublicReviews>(
      'GET',
      `/v1/public/locations/${encodeURIComponent(slug)}/reviews${q ? `?${q}` : ''}`,
    );
  }

  /** Task 120: "Wolne dziś" — the specialists who can still be booked today. No sign-in. */
  freeToday(slug: string): Promise<PublicFreeToday> {
    return this.call<PublicFreeToday>(
      'GET',
      `/v1/public/locations/${encodeURIComponent(slug)}/free-today`,
    );
  }

  /** "Favourite salons" of the signed-in client, newest first (public salon data only). */
  favorites(): Promise<ClientFavorites> {
    return this.authed<ClientFavorites>('GET', '/v1/client/favorites');
  }

  /** Saves a salon to the favourites; saving it again changes nothing. */
  addFavorite(slug: string): Promise<void> {
    return this.authed<void>('PUT', `/v1/client/favorites/${encodeURIComponent(slug)}`);
  }

  /** Takes a salon off the favourites (no error when it is not there). */
  removeFavorite(slug: string): Promise<void> {
    return this.authed<void>('DELETE', `/v1/client/favorites/${encodeURIComponent(slug)}`);
  }

  /** Task 51: the signed-in client's waiting lists in every salon, soonest day first. */
  waitlist(): Promise<ClientWaitlist> {
    return this.authed<ClientWaitlist>('GET', '/v1/client/waitlist');
  }

  /**
   * "Tell me when a time becomes free" for a full day, with the signed-in client's email
   * (one specialist, or any when `staffId` is left out). Asking again changes nothing.
   */
  joinWaitlist(
    slug: string,
    input: { serviceId: string; staffId?: string; date: string; name: string; locale: Locale },
  ): Promise<WaitlistJoined> {
    return this.authed<WaitlistJoined>(
      'POST',
      `/v1/client/waitlist/locations/${encodeURIComponent(slug)}`,
      { ...input, acceptTerms: true },
    );
  }

  /** Leaves one waiting list (leaving twice is fine). */
  leaveWaitlist(id: string): Promise<ClientWaitlistEntry> {
    return this.authed<ClientWaitlistEntry>(
      'POST',
      `/v1/client/waitlist/${encodeURIComponent(id)}/cancel`,
    );
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
    return this.answer<T>(res);
  }

  private async answer<T>(res: Response): Promise<T> {
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
