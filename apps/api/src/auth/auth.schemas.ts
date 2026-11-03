import { z } from 'zod';

export const LOCALES = ['pl', 'uk', 'ru', 'en'] as const;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'must be a valid email address' }));

/** At least 10 characters; length is what matters most (NIST SP 800-63B). */
const newPassword = z.string().min(10, 'must be at least 10 characters').max(128);

export const registerSchema = z.object({
  email,
  password: newPassword,
  name: z.string().trim().min(1).max(100),
  locale: z.enum(LOCALES).default('pl'),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  /** web: refresh token in an httpOnly cookie; mobile: refresh token in the response body. */
  clientType: z.enum(['web', 'mobile']).default('web'),
  deviceName: z.string().trim().max(100).optional(),
});

export const refreshSchema = z.object({
  /** Mobile apps send it here; the web app relies on the cookie. */
  refreshToken: z.string().min(20).max(200).optional(),
});

export const emailOnlySchema = z.object({ email });

export const tokenSchema = z.object({ token: z.string().min(20).max(200) });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword,
});

/** Business app: sign in with a one-time email code instead of a password. */
export const requestLoginCodeSchema = z.object({
  email,
  /** Language of the email when the address has no account yet (an invited person). */
  locale: z.enum(LOCALES).default('pl'),
});

export const verifyLoginCodeSchema = z.object({
  email,
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
  /** web: refresh token in an httpOnly cookie; mobile: refresh token in the response body. */
  clientType: z.enum(['web', 'mobile']).default('web'),
  deviceName: z.string().trim().max(100).optional(),
  /** Name for an account created on first sign-in; default: the invited staff profile's name. */
  name: z.string().trim().min(1).max(100).optional(),
  locale: z.enum(LOCALES).default('pl'),
});

export type RequestLoginCodeInput = z.infer<typeof requestLoginCodeSchema>;
export type VerifyLoginCodeInput = z.infer<typeof verifyLoginCodeSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
