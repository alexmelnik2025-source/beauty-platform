/**
 * Shapes of the API responses the web app uses (see /v1/docs). They all come from
 * @beauty/api-client; only lists of values the interface needs at run time live here.
 */
import type { AppointmentStatus, Specialty } from '@beauty/api-client';

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
  Customer,
  CustomerDetail,
  ClientAppointment,
  ClientLoyalty,
  ClientDataExport,
  ClientLoyaltyCard,
  ClientPerson,
  FailedEmail,
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
  PublicLocation,
  PublicSalon,
  PublicSalonDirectory,
  PushPublicKey,
  Role,
  SalonReport,
  Service,
  ServiceCategory,
  Slot,
  Staff,
  StaffCategory,
  TimeBlock,
  TimeBlockSeries,
  TimeOff,
  UnreadCount,
  VisitCoupons,
  WorkingHours,
} from '@beauty/api-client';
