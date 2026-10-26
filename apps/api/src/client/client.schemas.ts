import { z } from 'zod';
import { LOCALES } from '../auth/auth.schemas';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'must be a valid email address' }));

export const requestClientCodeSchema = z.object({
  email,
  /** Language of the email with the code. */
  locale: z.enum(LOCALES).default('pl'),
});

export const verifyClientCodeSchema = z.object({
  email,
  code: z.string().regex(/^\d{6}$/, 'the code has 6 digits'),
  locale: z.enum(LOCALES).optional(),
  /** web: the session is an httpOnly cookie. mobile: the token is returned in the body. */
  clientType: z.enum(['web', 'mobile']).default('web'),
});

export const listClientAppointmentsSchema = z.object({
  /** upcoming: not finished yet, soonest first. past: finished or cancelled, newest first. */
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
});

export const updatePersonSchema = z.object({
  locale: z.enum(LOCALES),
});

export type RequestClientCodeInput = z.infer<typeof requestClientCodeSchema>;
export type VerifyClientCodeInput = z.infer<typeof verifyClientCodeSchema>;
export type ListClientAppointmentsInput = z.infer<typeof listClientAppointmentsSchema>;
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;
