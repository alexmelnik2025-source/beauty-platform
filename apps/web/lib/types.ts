/**
 * Shapes of the API responses the web app uses (see /v1/docs). They all come from
 * @beauty/api-client; only lists of values the interface needs at run time live here.
 */
import type { AppointmentDetail, AppointmentStatus, Specialty } from '@beauty/api-client';

/** Languages spoken with clients (be = Belarusian). Not the interface languages. */
export const SPOKEN = ['pl', 'uk', 'ru', 'be', 'en'] as const;
export type Spoken = (typeof SPOKEN)[number];
/** What a specialist does, in the order the picker shows them. */
export const SPECIALTIES = [
  'hairdresser',
  'barber',
  'nails',
  'cosmetologist',
  'brows_lashes',
  'makeup',
  'massage',
] as const satisfies readonly Specialty[];
// A new value on the server must be added above, or this line fails to compile.
const _everySpecialty: Exclude<Specialty, (typeof SPECIALTIES)[number]> extends never
  ? true
  : never = true;
void _everySpecialty;
export type { Specialty };
/** Task 227: how the client paid, in the order the picker shows them. */
export type PaymentMethod = NonNullable<AppointmentDetail['paymentMethod']>;
export const PAYMENT_METHODS = [
  'cash',
  'card',
  'blik',
  'transfer',
  'other',
] as const satisfies readonly PaymentMethod[];
const _everyPaymentMethod: Exclude<PaymentMethod, (typeof PAYMENT_METHODS)[number]> extends never
  ? true
  : never = true;
void _everyPaymentMethod;
export const APPOINTMENT_STATUSES = [
  'held',
  'confirmed',
  'cancelled',
  'expired',
  'completed',
  'no_show',
] as const satisfies readonly AppointmentStatus[];

/**
 * Generated from the API's OpenAPI document, so these can never drift from the server:
 * what clients see (booking page, manage link, "My visits"), the salon account and catalogue,
 * appointments, client cards, time blocks, the calendar, the team, permissions, invitations,
 * notifications, push, photos, the email queue and the loyalty program.
 */
export type {
  Appointment,
  AppointmentDetail,
  AppointmentStatus,
  Calendar,
  CancellationGuard,
  GuardedClient,
  GuardedClients,
  Customer,
  CustomerDetail,
  CustomerSegments,
  CustomerTags,
  ClientAppointment,
  ClientLoyalty,
  ClientDataExport,
  ClientLoyaltyCard,
  ClientContact,
  ClientPerson,
  FailedEmail,
  HappyHours,
  Hold,
  Invitation,
  LegalTemplates,
  InvitationAccepted,
  InvitationPreview,
  Location,
  LoyaltyAccount,
  LoyaltyBonusRules,
  LoyaltyCoupon,
  LoyaltyProgram,
  LoyaltyReward,
  LoyaltyTiers,
  WaitlistJoined,
  LoyaltyTransaction,
  Me,
  Member,
  Notification,
  OutboxStats,
  PermissionCatalog,
  PermissionKey,
  PermissionMap,
  Permissions,
  Photo,
  PublicAppointment,
  PublicLegalTexts,
  PublicWaitlistEntry,
  WaitlistOffer,
  VisitPhoto,
  VisitPhotoList,
  ReviewSettings,
  VisitReview,
  PublicReviews,
  SalonReviews,
  SalonWaitlist,
  SalonWaitlistEntry,
  PublicFreeToday,
  PublicLocation,
  PublicSalon,
  PublicSalonDirectory,
  PushPublicKey,
  Role,
  SalonReport,
  TillClose,
  Service,
  ServiceCategory,
  Slot,
  Staff,
  StaffCategory,
  StaffPrices,
  TimeBlock,
  TimeBlockSeries,
  TimeOff,
  UnreadCount,
  VisitCoupons,
  WorkingHours,
} from '@beauty/api-client';
