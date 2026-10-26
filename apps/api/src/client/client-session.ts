import type { Response } from 'express';
import { generateToken, hashToken } from '../common/crypto';
import type { ClientType, Locale, Person, Prisma } from '../generated/prisma/client';

const DAY_MS = 86_400_000;
export const CLIENT_SESSION_DAYS = 90;

export const CLIENT_COOKIE = 'bp_client';
/** The cookie is only sent to the client app endpoints, never to the salon API. */
const COOKIE_PATH = '/v1/client';

export interface NewClientSession {
  person: Person;
  token: string;
  expiresAt: Date;
}

/**
 * Signs a client in to "My visits" for an email that was just confirmed with a
 * one-time code (the sign-in code, or the code of an online booking).
 * Only the hash of the token is stored.
 */
export async function createClientSession(
  tx: Prisma.TransactionClient,
  input: {
    email: string;
    locale?: Locale;
    clientType: ClientType;
    userAgent: string | null;
  },
): Promise<NewClientSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + CLIENT_SESSION_DAYS * DAY_MS);
  const person = await tx.person.upsert({
    where: { email: input.email },
    create: { email: input.email, locale: input.locale ?? 'pl' },
    update: { lastSeenAt: new Date(), ...(input.locale ? { locale: input.locale } : {}) },
  });
  await tx.clientSession.create({
    data: {
      personId: person.id,
      clientType: input.clientType,
      tokenHash: hashToken(token),
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
  });
  return { person, token, expiresAt };
}

export function setClientCookie(res: Response, token: string, expiresAt: Date, secure: boolean) {
  res.cookie(CLIENT_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearClientCookie(res: Response, secure: boolean): void {
  res.clearCookie(CLIENT_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: COOKIE_PATH });
}
