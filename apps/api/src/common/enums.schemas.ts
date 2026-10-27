import { z } from 'zod';
import type { AppointmentStatus, Language, Locale } from '../generated/prisma/client';

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

// The lists above must name every database value: adding one to the schema fails here.
type Missing<Db extends string, Listed extends string> =
  Exclude<Db, Listed> extends never ? true : never;
const _everyValueListed: [
  Missing<Language, z.infer<typeof languageSchema>>,
  Missing<Locale, z.infer<typeof localeSchema>>,
  Missing<AppointmentStatus, z.infer<typeof appointmentStatusSchema>>,
] = [true, true, true];
void _everyValueListed;
