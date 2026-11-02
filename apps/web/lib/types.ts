/**
 * Shapes of the API responses the web app uses (see /v1/docs). They all come from
 * @beauty/api-client; only lists of values the interface needs at run time live here.
 */
import type { AppointmentStatus } from '@beauty/api-client';

/** Languages spoken with clients (be = Belarusian). Not the interface languages. */
export const SPOKEN = ['pl', 'uk', 'ru', 'be', 'en'] as const;
export type Spoken = (typeof SPOKEN)[number];
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
 * appointments, client cards, time blocks, the calendar, the team, permissions and invitations.
 */
export type {
  Appointment,
  AppointmentDetail,
  AppointmentStatus,
  Calendar,
  Customer,
  CustomerDetail,
  ClientAppointment,
  ClientPerson,
  Hold,
  Invitation,
  InvitationAccepted,
  InvitationPreview,
  Location,
  Me,
  Member,
  PermissionCatalog,
  PermissionKey,
  PermissionMap,
  Permissions,
  PublicAppointment,
  PublicLocation,
  Role,
  Service,
  Slot,
  Staff,
  StaffCategory,
  TimeBlock,
} from '@beauty/api-client';
