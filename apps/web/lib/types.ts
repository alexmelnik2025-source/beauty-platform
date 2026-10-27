/** Shapes of the API responses the web app uses (see /v1/docs). Salon-side shapes are still written by hand. */

export type Role = 'owner' | 'manager' | 'staff';
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
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export interface Me {
  user: { id: string; email: string; name: string; locale: string; emailVerified: boolean };
  organizations: { id: string; name: string; role: Role }[];
  isPlatformAdmin: boolean;
}

export interface Location {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  timezone: string;
  addressLine: string;
  city: string;
  postalCode: string;
  phone: string | null;
  onlineBookingEnabled: boolean;
  slotStepMinutes: number;
  version: number;
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  priceGrosze: number;
  active: boolean;
  categoryId: string | null;
  color: string | null;
}

export interface Staff {
  id: string;
  displayName: string;
  active: boolean;
  serviceIds: string[];
  userId: string | null;
  /** /v1/public/photos/<id>; null when there is no photo. */
  photoUrl: string | null;
}

export interface Appointment {
  id: string;
  status: AppointmentStatus;
  source: 'online' | 'manual';
  start: string;
  end: string;
  blockedUntil: string;
  date: string;
  time: string;
  staff: { id: string; displayName: string };
  service: { id: string; name: string };
  customer: { id: string; name: string; phone: string | null; email: string | null } | null;
  priceGrosze: number | null;
  staffChosenByClient: boolean;
  firstVisit: boolean;
  durationMinutes: number;
  note: string | null;
  holdExpiresAt: string | null;
  cancelReason: string | null;
  version: number;
}

export interface AppointmentDetail extends Appointment {
  history: { type: string; actor: string; at: string; data: unknown }[];
}

export interface TimeBlock {
  id: string;
  staffId: string | null;
  start: string;
  end: string;
  reason: string | null;
  version: number;
  deleted: boolean;
}

export interface Calendar {
  location: { id: string; name: string; timezone: string; slotStepMinutes: number };
  from: string;
  to: string;
  staff: {
    id: string;
    displayName: string;
    days: { date: string; intervals: { start: string; end: string }[] }[];
  }[];
  timeOff: { id: string; staffId: string; start: string; end: string; note: string | null }[];
  appointments: Appointment[];
  blocks: TimeBlock[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

export interface MyPermissions {
  me: { role: Role; permissions: Record<string, boolean> };
}

/**
 * What clients see (booking page, manage link, "My visits"): generated from the API's
 * OpenAPI document, so these can never drift from the server.
 */
export type {
  ClientAppointment,
  ClientPerson,
  Hold,
  PublicAppointment,
  PublicLocation,
  Slot,
} from '@beauty/api-client';
