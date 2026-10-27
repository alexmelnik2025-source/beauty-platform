/** Shapes of the API responses the web app uses (see /v1/docs). */

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

export interface PublicLocation {
  slug: string;
  name: string;
  addressLine: string;
  city: string;
  postalCode: string;
  phone: string | null;
  timezone: string;
  defaultLocale: string;
  languages: Spoken[];
  /** What the salon writes about itself. */
  description: string | null;
  /** Monday (1) to Sunday (7), from the team's regular weekly hours; empty intervals = closed. */
  openingHours: { weekday: number; intervals: { start: string; end: string }[] }[];
  /** Where the booking code can go: always email; sms when an SMS gateway is connected. */
  codeChannels: ('email' | 'sms')[];
  /** Salon photos, oldest first. */
  photos: { id: string; url: string }[];
  categories: { id: string; name: string }[];
  services: {
    id: string;
    categoryId: string | null;
    name: string;
    description: string | null;
    durationMinutes: number;
    priceGrosze: number;
  }[];
  staff: {
    id: string;
    displayName: string;
    bio: string | null;
    languages: Spoken[];
    serviceIds: string[];
    photoUrl: string | null;
  }[];
}

export interface Slot {
  start: string;
  date: string;
  time: string;
  staffIds: string[];
}

export interface Hold {
  holdId: string;
  holdToken: string;
  expiresAt: string;
  start: string;
  end: string;
  date: string;
  time: string;
  staffId: string;
  staffName: string;
  serviceName: string;
  priceGrosze: number;
}

export interface PublicAppointment {
  id: string;
  status: AppointmentStatus;
  start: string;
  end: string;
  date: string;
  time: string;
  timezone: string;
  service: { id: string; name: string; durationMinutes: number; priceGrosze: number };
  staff: { id: string; displayName: string };
  salon: {
    name: string;
    slug: string;
    addressLine: string;
    city: string;
    postalCode: string;
    phone: string | null;
  };
  changeableUntil: string;
  canChange: boolean;
}

/** "My visits" client app. */
export interface ClientPerson {
  id: string;
  email: string;
  locale: string;
}

export interface ClientAppointment extends PublicAppointment {
  /** Same service and staff member again; null when the salon no longer takes it online. */
  bookAgain: { slug: string; serviceId: string; staffId: string | null } | null;
}
