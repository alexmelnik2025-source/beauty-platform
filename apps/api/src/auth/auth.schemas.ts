import { z } from 'zod';

export const LOCALES = ['pl', 'uk', 'ru', 'en', 'tr', 'sq'] as const;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'must be a valid email address' }));

/** E.164 after removing spaces, brackets and dashes, e.g. +48600100200. */
export const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'use international format, e.g. +48123456789'));

const emailOrPhone = {
  message: 'send either email or phone',
  path: ['email'],
};
const oneOf = (v: { email?: string; phone?: string }): boolean => !v.email !== !v.phone;

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

/**
 * Business app: sign in with a one-time code instead of a password, by email or by phone.
 * By phone the code goes by SMS when a gateway is connected, otherwise to the email of the
 * account or invitation with that number.
 */
export const requestLoginCodeSchema = z
  .object({
    email: email.optional(),
    phone: phoneSchema.optional(),
    /** Language of the message when there is no account yet (an invited person). */
    locale: z.enum(LOCALES).default('pl'),
  })
  .refine(oneOf, emailOrPhone);

export const verifyLoginCodeSchema = z
  .object({
    /** The same email or phone the code was requested with. */
    email: email.optional(),
    phone: phoneSchema.optional(),
    code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
    /** web: refresh token in an httpOnly cookie; mobile: refresh token in the response body. */
    clientType: z.enum(['web', 'mobile']).default('web'),
    deviceName: z.string().trim().max(100).optional(),
    /** Name for an account created on first sign-in; default: the invited staff profile's name. */
    name: z.string().trim().min(1).max(100).optional(),
    locale: z.enum(LOCALES).default('pl'),
  })
  .refine(oneOf, emailOrPhone);

export type RequestLoginCodeInput = z.infer<typeof requestLoginCodeSchema>;
export type VerifyLoginCodeInput = z.infer<typeof verifyLoginCodeSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
