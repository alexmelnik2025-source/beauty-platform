import { z } from 'zod';
import type {
  AppointmentSource,
  AppointmentStatus,
  CancelledBy,
  ClientType,
  Language,
  Locale,
  MembershipRole,
  MembershipStatus,
  Specialty,
} from '../generated/prisma/client';

/** Languages a salon or staff member speaks with clients (be = Belarusian). */
export const languageSchema = z.enum(['pl', 'uk', 'ru', 'be', 'en'] satisfies Language[]);

/** What a specialist does (the whole beauty trade); the salon's own words go to customSpecialty. */
export const specialtySchema = z.enum([
  'hairdresser',
  'barber',
  'nails',
  'cosmetologist',
  'brows_lashes',
  'makeup',
  'massage',
] satisfies Specialty[]);

/** Interface and email languages. */
export const localeSchema = z.enum(['pl', 'uk', 'ru', 'en', 'tr', 'sq'] satisfies Locale[]);

export const appointmentStatusSchema = z.enum([
  'held',
  'confirmed',
  'cancelled',
  'expired',
  'completed',
  'no_show',
] satisfies AppointmentStatus[]);

/** online = booked by the client, manual = entered by the salon. */
export const appointmentSourceSchema = z.enum(['online', 'manual'] satisfies AppointmentSource[]);

/** Who cancelled an appointment. */
export const cancelledBySchema = z.enum(['customer', 'salon'] satisfies CancelledBy[]);

/** Role of a salon team member in an organization. */
export const membershipRoleSchema = z.enum([
  'owner',
  'manager',
  'staff',
] satisfies MembershipRole[]);

/** invited = has not signed in to the team yet, active = works in it. */
export const membershipStatusSchema = z.enum(['invited', 'active'] satisfies MembershipStatus[]);

/** Where a salon session was opened. */
export const clientTypeSchema = z.enum(['web', 'mobile'] satisfies ClientType[]);

// The lists above must name every database value: adding one to the schema fails here.
type Missing<Db extends string, Listed extends string> =
  Exclude<Db, Listed> extends never ? true : never;
const _everyValueListed: [
  Missing<Language, z.infer<typeof languageSchema>>,
  Missing<Locale, z.infer<typeof localeSchema>>,
  Missing<AppointmentStatus, z.infer<typeof appointmentStatusSchema>>,
  Missing<MembershipRole, z.infer<typeof membershipRoleSchema>>,
  Missing<MembershipStatus, z.infer<typeof membershipStatusSchema>>,
  Missing<ClientType, z.infer<typeof clientTypeSchema>>,
  Missing<AppointmentSource, z.infer<typeof appointmentSourceSchema>>,
  Missing<CancelledBy, z.infer<typeof cancelledBySchema>>,
  Missing<Specialty, z.infer<typeof specialtySchema>>,
] = [true, true, true, true, true, true, true, true, true];
void _everyValueListed;
