import type {
  AppointmentDetail,
  Calendar,
  CustomerDetail,
  Location,
  LoginCodeSent,
  Me,
  PermissionCatalog,
  SalonReport,
  TillClose,
  Tokens,
  components,
} from '@beauty/api-client';
import type { MessagesChanges } from './messages';
import type { SalonChanges } from './salon';
import { paymentBody, type PaymentMethod } from './payment';

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
export type CustomerTags = components['schemas']['CustomerTags'];
/** Task 273: how many clients each quick filter of the client list would show. */
export type CustomerSegments = components['schemas']['CustomerSegments'];
export type LoyaltyAccount = components['schemas']['LoyaltyAccount'];
/** Task 206: the salon's loyalty program, its rewards and operations. */
export type LoyaltyProgram = components['schemas']['LoyaltyProgram'];
export type LoyaltyReward = components['schemas']['LoyaltyReward'];
export type LoyaltyTransaction = components['schemas']['LoyaltyTransaction'];
/** What PUT …/loyalty/program takes: every setting plus the version read. */
export type LoyaltyProgramSave = Omit<LoyaltyProgram, 'earnRules'>;
/** A new reward as the server takes it: a discount in % or a free service, for stamps or points. */
export interface NewLoyaltyReward {
  name: string;
  kind: 'discount_percent' | 'free_service';
  discountPercent: number | null;
  freeServiceId: string | null;
  cost: number;
}
export type GuardedClient = components['schemas']['GuardedClient'];
/** Task 207: the salon's cancellation protection and the clients it marks now. */
export type CancellationGuard = components['schemas']['CancellationGuard'];
export type GuardedClients = components['schemas']['GuardedClients'];
export type TimeBlock = components['schemas']['TimeBlock'];
export type TimeBlockList = components['schemas']['TimeBlockList'];
export type NotificationList = components['schemas']['NotificationList'];
/** Task 80b: the client's example photos for a visit (signed links, valid for an hour). */
export type VisitPhotoList = components['schemas']['VisitPhotoList'];
export type ServiceList = components['schemas']['ServiceList'];
/** Task 99: cheaper hours of the salon (happy hours). */
export type HappyHours = components['schemas']['HappyHours'];
/** One rule as the server takes it (the whole list is saved at once). */
export interface HappyHourRule {
  weekdays: number[];
  start: string;
  end: string;
  discountPercent: number;
  staffIds: string[];
  serviceIds: string[];
}
/** Task 93: the salon's service categories (the order of the price list). */
export type ServiceCategoryList = components['schemas']['ServiceCategoryList'];
/** What the owner or a manager changes in a service from the app. */
export interface ServiceChange {
  version: number;
  priceGrosze?: number;
  durationMinutes?: number;
  active?: boolean;
  /** Task 311: another category; null = without a category. */
  categoryId?: string | null;
}
/** Task 310: a new service as the server takes it (the copy of one — "Duplikuj"). */
export interface NewService {
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  priceGrosze: number;
  active: boolean;
  categoryId: string | null;
  color: string | null;
  wishPhotos: boolean;
  staffIds: string[];
}
/** Task 310: own prices and durations of specialists (only the ones that differ). */
export type StaffPrices = components['schemas']['StaffPrices'];
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
/** Task 150: who changed what in the salon (owner only). */
export type AuditLog = components['schemas']['AuditLog'];
/** Task 201: the salon's reviews (task 165b) in the app. */
export type SalonReviews = components['schemas']['SalonReviews'];
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
  /** Task 227: with paid, how the client paid. */
  paymentMethod?: PaymentMethod;
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
  TillClose,
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

/** Task 220: the accountant's CSV of a period, as the server named it. */
/** The filters of the client list (also for its CSV, task 275); empty values are left out. */
export interface ClientFilters {
  search?: string;
  inactiveDays?: number;
  tag?: string;
  birthdayDays?: number;
  consented?: boolean;
  newDays?: number;
  overdue?: boolean;
  noShows?: boolean;
  once?: boolean;
}

export function setClientFilters(query: URLSearchParams, f: ClientFilters): void {
  if (f.search?.trim()) query.set('search', f.search.trim());
  if (f.inactiveDays) query.set('inactiveDays', String(f.inactiveDays));
  if (f.tag) query.set('tag', f.tag);
  // Task 240: only birthdays in the next `birthdayDays` days, soonest first.
  if (f.birthdayDays) query.set('birthdayDays', String(f.birthdayDays));
  // Task 245: only clients who agreed to the salon messages.
  if (f.consented) query.set('marketing', 'yes');
  // Task 248: only clients whose first visit was in the last `newDays` days, newest first.
  if (f.newDays) query.set('newDays', String(f.newDays));
  // Task 262: only regular clients past their usual break with nothing booked.
  if (f.overdue) query.set('overdue', 'yes');
  // Task 264: only clients who did not come at least once in the last year.
  if (f.noShows) query.set('noShows', 'yes');
  // Task 270: only clients who came once and have nothing booked.
  if (f.once) query.set('once', 'yes');
}

/** Task 279: the order of the client list. */
/** Task 279 (281: `next` — the nearest booked visit first; 283: `paid` — who paid the most). */
export type ClientSort = 'name' | 'recent' | 'visits' | 'next' | 'paid';

export interface CsvFile {
  fileName: string;
  csv: string;
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
    changes: SalonChanges | MessagesChanges,
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

  /** Task 214: several days of the calendar at once (the "Tydzień" overview). */
  calendarRange(orgId: string, locationId: string, from: string, to: string): Promise<Calendar> {
    const query = new URLSearchParams({ from, to }).toString();
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

  /** Task 161b: accept a visit that waits for the salon (cancellation guard). */
  approve(
    orgId: string,
    locationId: string,
    id: string,
    version: number,
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>(
      'POST',
      `${appointmentPath(orgId, locationId, id)}/approve`,
      { version },
    );
  }

  /** Task 229: the tip the client left on a visit that took place (0 = none). */
  setTip(
    orgId: string,
    locationId: string,
    id: string,
    version: number,
    tipGrosze: number,
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>('PUT', `${appointmentPath(orgId, locationId, id)}/tip`, {
      version,
      tipGrosze,
    });
  }

  /** Paid (earns loyalty stamps or points) or not paid (a refund takes them back). */
  setPaid(
    orgId: string,
    locationId: string,
    id: string,
    version: number,
    paid: boolean,
    /** Task 227: how the client paid; on a paid visit another method only changes it. */
    method?: PaymentMethod | null,
  ): Promise<AppointmentDetail> {
    return this.authed<AppointmentDetail>(
      'POST',
      `${appointmentPath(orgId, locationId, id)}/payment`,
      paymentBody(version, paid, method),
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

  /** Owner only (the server checks): the change log, newest first; `before` = the page's `next`. */
  auditLog(orgId: string, before?: string, limit = 50): Promise<AuditLog> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    return this.authed<AuditLog>('GET', `/v1/organizations/${enc(orgId)}/audit-log?${query}`);
  }

  /**
   * Task 201: reviews of the salon, newest first, 20 at a time; `before` = the last one shown.
   * A specialist without "all appointments" gets only reviews of their own visits (the server checks).
   */
  reviews(orgId: string, locationId: string, before?: string): Promise<SalonReviews> {
    const query = before ? `?${new URLSearchParams({ before })}` : '';
    return this.authed<SalonReviews>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reviews${query}`,
    );
  }

  /** Task 211: the salon's public answer under a review (owner or manager — the server checks). */
  replyToReview(
    orgId: string,
    locationId: string,
    reviewId: string,
    text: string,
  ): Promise<SalonReviews['items'][number]> {
    return this.authed<SalonReviews['items'][number]>(
      'PUT',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reviews/${enc(reviewId)}/reply`,
      { text },
    );
  }

  removeReviewReply(
    orgId: string,
    locationId: string,
    reviewId: string,
  ): Promise<SalonReviews['items'][number]> {
    return this.authed<SalonReviews['items'][number]>(
      'DELETE',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reviews/${enc(reviewId)}/reply`,
    );
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
  customers(
    orgId: string,
    search: string,
    limit = 50,
    inactiveDays = 0,
    tag = '',
    birthdayDays = 0,
    consented = false,
    newDays = 0,
    overdue = false,
    noShows = false,
    once = false,
    offset = 0,
    sort: ClientSort = 'name',
  ): Promise<CustomerList> {
    const query = new URLSearchParams({ limit: String(limit) });
    setClientFilters(query, {
      search,
      inactiveDays,
      tag,
      birthdayDays,
      consented,
      newDays,
      overdue,
      noShows,
      once,
    });
    // Task 277: the next page of the same list ("Pokaż więcej klientów").
    if (offset) query.set('offset', String(offset));
    // Task 279: the latest visit first or the most visits first (A–Z is the default);
    // task 281: the nearest booked visit first.
    if (sort !== 'name') query.set('sort', sort);
    return this.authed<CustomerList>(
      'GET',
      `/v1/organizations/${enc(orgId)}/customers?${query.toString()}`,
    );
  }

  /** Task 224: the salon's client labels with how many clients have each (owner, manager). */
  customerTags(orgId: string): Promise<CustomerTags> {
    return this.authed<CustomerTags>('GET', `/v1/organizations/${enc(orgId)}/customers/tags`);
  }

  /** Task 273: the numbers next to the client list's quick filters (owner, manager). */
  customerSegments(orgId: string): Promise<CustomerSegments> {
    return this.authed<CustomerSegments>(
      'GET',
      `/v1/organizations/${enc(orgId)}/customers/segments`,
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

  /** Task 241: owner or manager (the server checks) — "MM-DD" without a year, or null to remove. */
  updateCustomerBirthday(
    orgId: string,
    id: string,
    version: number,
    birthday: string | null,
  ): Promise<CustomerDetail> {
    return this.authed<CustomerDetail>('PATCH', customerPath(orgId, id), { version, birthday });
  }

  /** Owner or manager only (the server checks): the client's stamps or points, tier and coupons. */
  loyaltyAccount(orgId: string, customerId: string): Promise<LoyaltyAccount> {
    return this.authed<LoyaltyAccount>(
      'GET',
      `/v1/organizations/${enc(orgId)}/loyalty/accounts/${enc(customerId)}`,
    );
  }

  /** Task 206, owner or manager only (the server checks): the program settings (version 0 = never saved). */
  loyaltyProgram(orgId: string): Promise<LoyaltyProgram> {
    return this.authed<LoyaltyProgram>('GET', `${loyaltyPath(orgId)}/program`);
  }

  /** Saves the whole settings with the version read; 409 VERSION_CONFLICT when changed meanwhile. */
  saveLoyaltyProgram(orgId: string, body: LoyaltyProgramSave): Promise<LoyaltyProgram> {
    return this.authed<LoyaltyProgram>('PUT', `${loyaltyPath(orgId)}/program`, body);
  }

  /** The reward catalogue (removed rewards left out). */
  loyaltyRewards(orgId: string): Promise<LoyaltyReward[]> {
    return this.authed<LoyaltyReward[]>('GET', `${loyaltyPath(orgId)}/rewards`);
  }

  addLoyaltyReward(orgId: string, reward: NewLoyaltyReward): Promise<LoyaltyReward> {
    return this.authed<LoyaltyReward>('POST', `${loyaltyPath(orgId)}/rewards`, reward);
  }

  /** "Usuń z katalogu": coupons clients already took stay valid. */
  removeLoyaltyReward(orgId: string, rewardId: string): Promise<void> {
    return this.authed<void>('DELETE', `${loyaltyPath(orgId)}/rewards/${enc(rewardId)}`);
  }

  /** The salon's latest stamps and points operations, newest first. */
  loyaltyTransactions(orgId: string, limit = 20): Promise<LoyaltyTransaction[]> {
    return this.authed<LoyaltyTransaction[]>(
      'GET',
      `${loyaltyPath(orgId)}/transactions?${new URLSearchParams({ limit: String(limit) }).toString()}`,
    );
  }

  /** Task 207, owner or manager only (the server checks): the settings (version 0 = never saved). */
  guardSettings(orgId: string, locationId: string): Promise<CancellationGuard> {
    return this.authed<CancellationGuard>('GET', guardPath(orgId, locationId));
  }

  /** Saves the whole settings with the version read; 409 VERSION_CONFLICT when changed meanwhile. */
  saveGuardSettings(
    orgId: string,
    locationId: string,
    body: CancellationGuard,
  ): Promise<CancellationGuard> {
    return this.authed<CancellationGuard>('PUT', guardPath(orgId, locationId), body);
  }

  /** The clients the protection marks now (empty while it is off). */
  guardedClients(orgId: string, locationId: string): Promise<GuardedClients> {
    return this.authed<GuardedClients>('GET', `${guardPath(orgId, locationId)}/clients`);
  }

  /** Task 161c, owner or manager only (the server checks): the client's cancellation-protection mark. */
  guardClient(orgId: string, locationId: string, customerId: string): Promise<GuardedClient> {
    return this.authed<GuardedClient>('GET', guardClientPath(orgId, locationId, customerId));
  }

  /** "Zdejmij blokadę": counting starts again, the history stays. */
  releaseGuard(
    orgId: string,
    locationId: string,
    customerId: string,
    note: string,
  ): Promise<GuardedClient> {
    return this.authed<GuardedClient>(
      'POST',
      `${guardClientPath(orgId, locationId, customerId)}/release`,
      note.trim() ? { note: note.trim() } : {},
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

  /** Task 99: the salon's happy hours (everyone who works there may read them). */
  happyHours(orgId: string, locationId: string): Promise<HappyHours> {
    return this.authed<HappyHours>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/happy-hours`,
    );
  }

  /** Owner or manager only: replaces the whole list; visits already booked keep their price. */
  saveHappyHours(orgId: string, locationId: string, rules: HappyHourRule[]): Promise<HappyHours> {
    return this.authed<HappyHours>(
      'PUT',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/happy-hours`,
      { rules },
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

  /** Task 310: owner or manager — a new service (a copy made with "Duplikuj"). */
  createService(orgId: string, locationId: string, body: NewService): Promise<ServiceList[number]> {
    return this.authed<ServiceList[number]>(
      'POST',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/services`,
      body,
    );
  }

  /** Task 311: owner or manager — a new category; the server puts it at the end (task 254). */
  createServiceCategory(
    orgId: string,
    locationId: string,
    name: string,
  ): Promise<ServiceCategoryList[number]> {
    return this.authed<ServiceCategoryList[number]>(
      'POST',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/service-categories`,
      { name },
    );
  }

  /** Task 310: own prices and durations of the specialists, for every service of the salon. */
  staffPrices(orgId: string, locationId: string): Promise<StaffPrices> {
    return this.authed<StaffPrices>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/staff-prices`,
    );
  }

  /** Task 310: replaces the own prices of one service (owner or manager). */
  saveStaffPrices(
    orgId: string,
    locationId: string,
    serviceId: string,
    prices: { staffId: string; priceGrosze: number }[],
  ): Promise<StaffPrices> {
    return this.authed<StaffPrices>(
      'PUT',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/services/${enc(serviceId)}/staff-prices`,
      { prices },
    );
  }

  /** Task 310: replaces the own durations of one service (owner or manager). */
  saveStaffDurations(
    orgId: string,
    locationId: string,
    serviceId: string,
    durations: { staffId: string; durationMinutes: number }[],
  ): Promise<StaffPrices> {
    return this.authed<StaffPrices>(
      'PUT',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/services/${enc(serviceId)}/staff-durations`,
      { durations },
    );
  }

  /** Task 253: owner or manager — every service of the salon once, first to last. */
  /** Task 255: every category of the salon once, first to last (owner or manager). */
  reorderServiceCategories(
    orgId: string,
    locationId: string,
    categoryIds: string[],
  ): Promise<ServiceCategoryList> {
    return this.authed<ServiceCategoryList>(
      'PUT',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/service-categories/order`,
      { categoryIds },
    );
  }

  reorderServices(orgId: string, locationId: string, serviceIds: string[]): Promise<ServiceList> {
    return this.authed<ServiceList>(
      'PUT',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/services/order`,
      { serviceIds },
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

  /**
   * Task 232: the day's till — what the visits paid in cash brought and, once counted, the cash
   * in the till. Owners and managers only (a specialist gets 403).
   */
  tillClose(orgId: string, locationId: string, date: string): Promise<TillClose> {
    const query = new URLSearchParams({ date }).toString();
    return this.authed<TillClose>(
      'GET',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reports/till-close?${query}`,
    );
  }

  /** Task 232: "Zamknij kasę" — the cash counted at the end of the day; again replaces it. */
  closeTill(
    orgId: string,
    locationId: string,
    date: string,
    countedCashGrosze: number,
    note: string | null,
  ): Promise<TillClose> {
    return this.authed<TillClose>(
      'PUT',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reports/till-close`,
      { date, countedCashGrosze, note },
    );
  }

  /** Task 236: "Wpłata / wypłata" — cash put into ("in") or taken out of ("out") the till. */
  addTillMovement(
    orgId: string,
    locationId: string,
    movement: { date: string; kind: 'in' | 'out'; amountGrosze: number; note: string },
  ): Promise<TillClose> {
    return this.authed<TillClose>(
      'POST',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reports/till-movements`,
      movement,
    );
  }

  /** Task 236: removes a cash movement noted by mistake; answers the till of its day. */
  removeTillMovement(orgId: string, locationId: string, movementId: string): Promise<TillClose> {
    return this.authed<TillClose>(
      'DELETE',
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reports/till-movements/${enc(movementId)}`,
    );
  }

  /**
   * Task 220: every visit of the period as the accountant's CSV (the same file as "Pobierz CSV"
   * in the cabinet; no client contacts). Same access as the report.
   */
  visitsCsv(
    orgId: string,
    locationId: string,
    from: string,
    to: string,
    locale: Locale,
  ): Promise<CsvFile> {
    return this.reportCsv('visits', orgId, locationId, from, to, locale);
  }

  /**
   * Task 238: the till's cash journal of the period ("CSV kasy": cash put in, taken out, till
   * closes). Owners and managers only.
   */
  tillCsv(
    orgId: string,
    locationId: string,
    from: string,
    to: string,
    locale: Locale,
  ): Promise<CsvFile> {
    return this.reportCsv('till', orgId, locationId, from, to, locale);
  }

  /**
   * Task 269: every client of the network as a CSV file — the same file as "Pobierz CSV" in the
   * cabinet's client list (contacts, consent, visits, no-shows, the next visit, what they paid).
   * Owners only (the server checks it); every download is written to the audit log.
   */
  clientsCsv(orgId: string, locale: Locale, filters: ClientFilters = {}): Promise<CsvFile> {
    const params = new URLSearchParams({ lang: locale });
    // Task 275: with the list's filters on — only the clients of the list.
    setClientFilters(params, filters);
    const query = params.toString();
    return this.csvFile(
      `/v1/organizations/${enc(orgId)}/customers/export.csv?${query}`,
      'klienci.csv',
    );
  }

  private reportCsv(
    file: 'visits' | 'till',
    orgId: string,
    locationId: string,
    from: string,
    to: string,
    locale: Locale,
  ): Promise<CsvFile> {
    const query = new URLSearchParams({ from, to, locale }).toString();
    return this.csvFile(
      `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/reports/${file}-csv?${query}`,
      `${file}-${from}-${to}.csv`,
    );
  }

  /** Downloads a CSV file (signed in), keeping the server's file name. */
  private async csvFile(path: string, fallbackName: string): Promise<CsvFile> {
    if (!this.accessToken && !(await this.refresh())) throw new ApiError(401, 'Not signed in');
    let res = await this.fetchCsv(path);
    if (res.status === 401 && (await this.refresh())) res = await this.fetchCsv(path);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      throw new ApiError(
        res.status,
        typeof data?.error?.message === 'string' ? data.error.message : `HTTP ${res.status}`,
        typeof data?.error?.code === 'string' ? data.error.code : undefined,
      );
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
    // Spreadsheet programs need the byte order mark to read UTF-8 (fetch may drop it).
    const csv = await res.text();
    return { fileName, csv: csv.startsWith('\uFEFF') ? csv : `\uFEFF${csv}` };
  }

  private fetchCsv(path: string): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        accept: 'text/csv',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
    });
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
const guardPath = (orgId: string, locationId: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/cancellation-guard`;
const guardClientPath = (orgId: string, locationId: string, customerId: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/cancellation-guard/clients/${enc(customerId)}`;
const customerPath = (orgId: string, id: string) =>
  `/v1/organizations/${enc(orgId)}/customers/${enc(id)}`;
const blocksPath = (orgId: string, locationId: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/time-blocks`;
const loyaltyPath = (orgId: string) => `/v1/organizations/${enc(orgId)}/loyalty`;
const waitlistPath = (orgId: string, locationId: string) =>
  `/v1/organizations/${enc(orgId)}/locations/${enc(locationId)}/waitlist`;
