import { z } from 'zod';
import { clientTypeSchema, localeSchema, membershipRoleSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

export const userSchema = responseSchema(
  'User',
  z.strictObject({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    locale: localeSchema,
    emailVerified: z.boolean(),
  }),
);
export type PublicUser = z.infer<typeof userSchema>;

export const messageSchema = responseSchema(
  'Message',
  z.strictObject({ message: z.string().describe('For people; do not parse it') }),
);
export type MessageResponse = z.infer<typeof messageSchema>;

export const tokensSchema = responseSchema(
  'Tokens',
  z.strictObject({
    accessToken: z.string().describe('Send as `Authorization: Bearer`'),
    expiresIn: z.number().int().describe('Seconds the access token is valid'),
    user: userSchema,
    refreshToken: z
      .string()
      .optional()
      .describe('Mobile only: keep it in the Keychain/Keystore. Web: an httpOnly cookie instead'),
    refreshExpiresAt: z.string().optional().describe('Mobile only'),
  }),
);
export type TokenResponse = z.infer<typeof tokensSchema>;

export const loginCodeSentSchema = responseSchema(
  'LoginCodeSent',
  z.strictObject({
    codeExpiresAt: z
      .string()
      .describe('The same answer for every address, with or without an account'),
  }),
);
export type LoginCodeSentResponse = z.infer<typeof loginCodeSentSchema>;

export const meSchema = responseSchema(
  'Me',
  z.strictObject({
    user: userSchema,
    organizations: z.array(
      z.strictObject({ id: z.string(), name: z.string(), role: membershipRoleSchema }),
    ),
    isPlatformAdmin: z.boolean().describe('Platform administrator (email queue page)'),
  }),
);
export type MeResponse = z.infer<typeof meSchema>;

export const sessionSchema = z.strictObject({
  id: z.string(),
  clientType: clientTypeSchema,
  deviceName: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  current: z.boolean().describe('The session making this request'),
});
export type SessionResponse = z.infer<typeof sessionSchema>;

export const sessionListSchema = responseSchema(
  'SessionList',
  z.array(sessionSchema).describe('Devices where the user is signed in, last used first'),
);
