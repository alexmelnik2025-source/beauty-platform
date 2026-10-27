import { z } from 'zod';
import type {
  AppointmentStatus,
  ClientType,
  Language,
  Locale,
  MembershipRole,
} from '../generated/prisma/client';

/** Languages a salon or staff member speaks with clients (be = Belarusian). */
export const languageSchema = z.enum(['pl', 'uk', 'ru', 'be', 'en'] satisfies Language[]);

/** Interface and email languages. */
export const localeSchema = z.enum(['pl', 'uk', 'ru', 'en'] satisfies Locale[]);

export const appointmentStatusSchema = z.enum([
  'held',
  'confirmed',
  'cancelled',
  'expired',
  'completed',
  'no_show',
] satisfies AppointmentStatus[]);

/** Role of a salon team member in an organization. */
export const membershipRoleSchema = z.enum([
  'owner',
  'manager',
  'staff',
] satisfies MembershipRole[]);

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
  Missing<ClientType, z.infer<typeof clientTypeSchema>>,
] = [true, true, true, true, true];
void _everyValueListed;
