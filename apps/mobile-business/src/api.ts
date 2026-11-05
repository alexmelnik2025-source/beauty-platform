import type {
  AppointmentDetail,
  Calendar,
  CustomerDetail,
  Location,
  LoginCodeSent,
  Me,
  PermissionCatalog,
  SalonReport,
  Tokens,
  components,
} from '@beauty/api-client';
import type { SalonChanges } from './salon';

/**
 * The business app's connection to the API: sign-in with a code (no password),
 * the signed-in user's salons and the day calendar. No React Native imports here,
 * so the same code is tested with Vitest (test/api.test.ts).
 */

export type Locale = 'pl' | 'uk' | 'ru' | 'en';
export type LocationList = components['schemas']['LocationList'];
export type StaffList = components['schemas']['StaffList'];
export type WorkingHours = components['schemas']['WorkingHours'];
export type TimeOff = components['schemas']['TimeOff'];
export type TimeOffList = components['schemas']['TimeOffList'];
export type CustomerList = components['schemas']['CustomerList'];
export type LoyaltyAccount = components['schemas']['LoyaltyAccount'];
export type TimeBlock = components['schemas']['TimeBlock'];
export type TimeBlockList = components['schemas']['TimeBlockList'];
export type NotificationList = components['schemas']['NotificationList'];
/** Task 80b: the client's example photos for a visit (signed links, valid for an hour). */
export type VisitPhotoList = components['schemas']['VisitPhotoList'];
export type ServiceList = components['schemas']['ServiceList'];
/** Task 93: the salon's service categories (the order of the price list). */
export type ServiceCategoryList = components['schemas']['ServiceCategoryList'];
/** What the owner or a manager changes in a service from the app. */
export interface ServiceChange {
  version: number;
  priceGrosze?: number;
  durationMinutes?: number;
  active?: boolean;
}
/** Task 92: the team — people with access and the invitations of the last 30 days. */
export type MemberList = components['schemas']['MemberList'];
export type Invitation = components['schemas']['Invitation'];
export type InvitationList = components['schemas']['InvitationList'];
/** What the owner (or a manager, for specialists) sends to give someone access. */
export interface NewInvitation {
  email: string;
  phone?: string;
  role: 'manager' | 'staff';
  locationIds: string[];
  /** A specialist's calendar profile without an account: the new account takes it over. */
  staffMemberId?: string;
  locale: Locale;
}
export type Availability = components['schemas']['Availability'];
/** Task 94: clients waiting for a free time (owner and manager only). */
export type SalonWaitlist = components['schemas']['SalonWaitlist'];
/** What the salon sends to book a client (phone call, walk-in); see NewVisitScreen. */
export interface NewAppointment {
  serviceId: string;
  staffId: string;
  /** ISO instant on a 5-minute mark. */
  start: string;
  customerId?: string;
  customer?: { name: string; phone: string; email?: string; locale?: Locale };
  note?: string;
  /** A walk-in entered afterwards (today or yesterday): saved as "came". */
  alreadyHappened?: boolean;
  /** With alreadyHappened: paid too, so loyalty stamps or points are earned. */
  paid?: boolean;
}
export type {
  AppointmentDetail,
  Calendar,
  CustomerDetail,
  Location,
  LoginCodeSent,
  Me,
  PermissionCatalog,
  SalonReport,
  Tokens,
};

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

  /** Task 131: one salon with everything the owner or a manager may change. */
  location(orgId: string, locationId: string): Promise<Location> {
    return this.authed<Location>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}`,
    );
  }

  /** Task 131: saves the salon's changes; `version` is the one read (someone else may have saved). */
  updateLocation(
    orgId: string,
    locationId: string,
    version: number,
    changes: SalonChanges,
  ): Promise<Location> {
    return this.authed<Location>(
      'PATCH',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}`,
      { ...changes, version },
    );
  }

  /** One day of the calendar; a specialist sees only what the server lets them see. */
  calendar(orgId: string, locationId: string, date: string): Promise<Calendar> {
    const query = new URLSearchParams({ from: date, to: date }).toString();
    return this.authed<Calendar>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/calendar?${query}`,
    );
  }

  /** What the signed-in person may do in this organization (role and permissions). */
  permissions(orgId: string): Promise<PermissionCatalog> {
    return this.authed<PermissionCatalog>('GET', `/v1/organizations/${enc(orgId)}/permissions`);
  }

  /** Specialists of the salon; `userId` links one of them to the signed-in person. */
  staff(orgId: string, locationId: string): Promise<StaffList> {
    return this.authed<StaffList>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/staff`,
    );
  }

  /**
   * Task 96: the languages a specialist speaks with clients — their own profile, or any
   * specialist's for an owner or manager (403 otherwise; the server checks).
   */
  setStaffLanguages(
    orgId: string,
    locationId: string,
    staffId: string,
    languages: StaffList[number]['languages'],
  ): Promise<StaffList[number]> {
    return this.authed<StaffList[number]>(
      'PUT',
      `${staffPath(orgId, locationId, staffId)}/languages`,
      { languages },
    );
  }

  /** A specialist's weekly hours and special days (location-local times). */
  workingHours(orgId: string, locationId: string, staffId: string): Promise<WorkingHours> {
    return this.authed<WorkingHours>(
      'GET',
      `${staffPath(orgId, locationId, staffId)}/working-hours`,
    );
  }

  /** Task 95, owner or manager only (the server checks): replaces the weekly hours. */
  setWorkingHours(
    orgId: string,
    locationId: string,
    staffId: string,
    days: { weekday: number; intervals: { start: string; end: string }[] }[],
  ): Promise<WorkingHours> {
    return this.authed<WorkingHours>(
      'PUT',
      `${staffPath(orgId, locationId, staffId)}/working-hours`,
      { days },
    );
  }

  /** Current and future time off of a specialist. */
  timeOff(orgId: string, locationId: string, staffId: string): Promise<TimeOffList> {
    return this.authed<TimeOffList>('GET', `${staffPath(orgId, locationId, staffId)}/time-off`);
  }

  /** Owner or manager only (the server checks): location-local 'YYYY-MM-DDTHH:mm'. */
  addTimeOff(
    orgId: string,
    locationId: string,
    staffId: string,
    body: { start: string; end: string; note?: string },
  ): Promise<TimeOff> {
    return this.authed<TimeOff>('POST', `${staffPath(orgId, locationId, staffId)}/time-off`, body);
  }

  removeTimeOff(orgId: string, locationId: string, staffId: string, id: string): Promise<void> {
    return this.authed<void>(
      'DELETE',
      `${staffPath(orgId, locationId, staffId)}/time-off/${enc(id)}`,
    );
  }

  /** One visit with its history; client contacts only when the person may see them. */
  appointment(orgId: string, locationId: string, id: string): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>('GET', appointmentPath(orgId, locationId, id));
  }

  /** Task 80b: the client's example photos for the visit (whoever may see the visit). */
  visitPhotos(orgId: string, locationId: string, id: string): Promise<VisitPhotoList> {
    return this.authed<VisitPhotoList>('GET', `${appointmentPath(orgId, locationId, id)}/photos`);
  }

  /** A picture link from the API ("/v1/…") as a full address for <Image>. */
  absoluteUrl(path: string): string {
    return /^https?:/.test(path) ? path : `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  /** "Came" (completed) or "did not come" (no_show). Send the version that was read. */
  setStatus(
    orgId: string,
    locationId: string,
    id: string,
    version: number,
    status: 'completed' | 'no_show',
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>(
      'POST',
      `${appointmentPath(orgId, locationId, id)}/status`,
      {
        version,
        status,
      },
    );
  }

  /** Paid (earns loyalty stamps or points) or not paid (a refund takes them back). */
  setPaid(
    orgId: string,
    locationId: string,
    id: string,
    version: number,
    paid: boolean,
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>(
      'POST',
      `${appointmentPath(orgId, locationId, id)}/payment`,
      {
        version,
        paid,
      },
    );
  }

  /** New, moved and cancelled visits for this person, newest first (every salon they belong to). */
  notifications(limit = 50): Promise<NotificationList> {
    return this.authed<NotificationList>('GET', `/v1/me/notifications?limit=${limit}`);
  }

  /** The number on the bell. */
  unreadNotifications(): Promise<{ unread: number }> {
    return this.authed<{ unread: number }>('GET', '/v1/me/notifications/unread-count');
  }

  /** Mark some notifications, or all of them, as read. */
  markNotificationsRead(which: { ids: string[] } | { all: true }): Promise<{ updated: number }> {
    return this.authed<{ updated: number }>('POST', '/v1/me/notifications/read', which);
  }

  /** Blocked time of one day (a specialist gets what the server lets them see). */
  timeBlocks(orgId: string, locationId: string, date: string): Promise<TimeBlockList> {
    const query = new URLSearchParams({ from: date, to: date }).toString();
    return this.authed<TimeBlockList>('GET', `${blocksPath(orgId, locationId)}?${query}`);
  }

  /**
   * Blocks time of one specialist or (staffId null) the whole salon; ISO times with offset.
   * 409 APPOINTMENTS_IN_THE_WAY when visits are booked then.
   */
  addTimeBlock(
    orgId: string,
    locationId: string,
    body: { staffId: string | null; start: string; end: string; reason?: string },
  ): Promise<TimeBlock> {
    return this.authed<TimeBlock>('POST', blocksPath(orgId, locationId), body);
  }

  removeTimeBlock(orgId: string, locationId: string, id: string): Promise<void> {
    return this.authed<void>('DELETE', `${blocksPath(orgId, locationId)}/${enc(id)}`);
  }

  /** Owner or manager only (the server checks): people with access and their roles. */
  members(orgId: string): Promise<MemberList> {
    return this.authed<MemberList>('GET', `/v1/organizations/${enc(orgId)}/members`);
  }

  /** Owner or manager only: invitations of the last 30 days (pending ones can be cancelled). */
  invitations(orgId: string): Promise<InvitationList> {
    return this.authed<InvitationList>('GET', `/v1/organizations/${enc(orgId)}/invitations`);
  }

  /**
   * Gives access by email (and phone): the person signs in with a code, no password.
   * 409 ALREADY_MEMBER / STAFF_ALREADY_LINKED; a manager may invite only specialists (403).
   */
  invite(orgId: string, body: NewInvitation): Promise<Invitation> {
    return this.authed<Invitation>('POST', `/v1/organizations/${enc(orgId)}/invitations`, body);
  }

  /** The invitation link stops working. */
  cancelInvitation(orgId: string, id: string): Promise<void> {
    return this.authed<void>('DELETE', `/v1/organizations/${enc(orgId)}/invitations/${enc(id)}`);
  }

  /** Owner only: access ends at once; the profile and visits stay in the calendar. */
  removeMember(orgId: string, membershipId: string): Promise<void> {
    return this.authed<void>(
      'DELETE',
      `/v1/organizations/${enc(orgId)}/members/${enc(membershipId)}`,
    );
  }

  /** Owner or manager only (the server checks): clients by name, phone, email or tag. */
  /** Task 140: `inactiveDays` — only clients who came before but not in that many days. */
  customers(orgId: string, search: string, limit = 50, inactiveDays = 0): Promise<CustomerList> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (search.trim()) query.set('search', search.trim());
    if (inactiveDays) query.set('inactiveDays', String(inactiveDays));
    return this.authed<CustomerList>(
      'GET',
      `/v1/organizations/${enc(orgId)}/customers?${query.toString()}`,
    );
  }

  /** One client card; a specialist gets only their own clients, contacts and notes by permission. */
  customer(orgId: string, id: string): Promise<CustomerDetail> {
    return this.authed<CustomerDetail>('GET', customerPath(orgId, id));
  }

  /** The client's note and tags (a specialist needs the permission). Send the version that was read. */
  updateCustomerNotes(
    orgId: string,
    id: string,
    version: number,
    note: string | null,
    tags: string[],
  ): Promise<CustomerDetail> {
    return this.authed<CustomerDetail>('PATCH', customerPath(orgId, id), { version, note, tags });
  }

  /** Owner or manager only (the server checks): the client's stamps or points, tier and coupons. */
  loyaltyAccount(orgId: string, customerId: string): Promise<LoyaltyAccount> {
    return this.authed<LoyaltyAccount>(
      'GET',
      `/v1/organizations/${enc(orgId)}/loyalty/accounts/${enc(customerId)}`,
    );
  }

  /** Owner or manager only (the server checks): who waits for a free time, from a day on. */
  waitlist(orgId: string, locationId: string, from: string): Promise<SalonWaitlist> {
    const query = new URLSearchParams({ from }).toString();
    return this.authed<SalonWaitlist>('GET', `${waitlistPath(orgId, locationId)}?${query}`);
  }

  /** "Usuń z listy": the client gets no message; removing twice is fine. */
  removeFromWaitlist(orgId: string, locationId: string, entryId: string): Promise<unknown> {
    return this.authed<unknown>(
      'POST',
      `${waitlistPath(orgId, locationId)}/${enc(entryId)}/remove`,
    );
  }

  /** The salon's services (with who performs each); inactive ones are left out on the screen. */
  services(orgId: string, locationId: string): Promise<ServiceList> {
    return this.authed<ServiceList>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/services`,
    );
  }

  /** Task 93: the salon's service categories. */
  serviceCategories(orgId: string, locationId: string): Promise<ServiceCategoryList> {
    return this.authed<ServiceCategoryList>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/service-categories`,
    );
  }

  /** Owner or manager only: price, duration, bookable online. 409 VERSION_CONFLICT when changed meanwhile. */
  updateService(
    orgId: string,
    locationId: string,
    id: string,
    change: ServiceChange,
  ): Promise<ServiceList[number]> {
    return this.authed<ServiceList[number]>(
      'PATCH',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/services/${enc(id)}`,
      change,
    );
  }

  /** Free start times of one specialist for a service on one day (salon-local date). */
  availability(
    orgId: string,
    locationId: string,
    query: { serviceId: string; staffId: string; date: string },
  ): Promise<Availability> {
    const params = new URLSearchParams({
      serviceId: query.serviceId,
      staffId: query.staffId,
      from: query.date,
      to: query.date,
    }).toString();
    return this.authed<Availability>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/availability?${params}`,
    );
  }

  /** Books a client on behalf of the salon; the server checks the rights and the time again. */
  createAppointment(
    orgId: string,
    locationId: string,
    body: NewAppointment,
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>(
      'POST',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/appointments`,
      body,
    );
  }

  /** Moves a confirmed visit to another free time of the same specialist; the client gets an email. */
  reschedule(
    orgId: string,
    locationId: string,
    id: string,
    version: number,
    start: string,
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>(
      'POST',
      `${appointmentPath(orgId, locationId, id)}/reschedule`,
      { version, start },
    );
  }

  /** Cancels a visit for the salon, with the reason the client reads in the email. */
  cancel(
    orgId: string,
    locationId: string,
    id: string,
    version: number,
    reason: string,
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>(
      'POST',
      `${appointmentPath(orgId, locationId, id)}/cancel`,
      { version, reason },
    );
  }

  /**
   * The salon report for a period (salon-local dates): the whole salon for an owner or manager,
   * a specialist's own visits with the "prices and own results" permission (403 otherwise).
   */
  report(orgId: string, locationId: string, from: string, to: string): Promise<SalonReport> {
    const query = new URLSearchParams({ from, to }).toString();
    return this.authed<SalonReport>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reports?${query}`,
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
const staffPath = (orgId: string, locationId: string, staffId: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/staff/${enc(staffId)}`;
const appointmentPath = (orgId: string, locationId: string, id: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/appointments/${enc(id)}`;
const customerPath = (orgId: string, id: string) =>
  `/v1/organizations/${enc(orgId)}/customers/${enc(id)}`;
const blocksPath = (orgId: string, locationId: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/time-blocks`;
const waitlistPath = (orgId: string, locationId: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/waitlist`;
