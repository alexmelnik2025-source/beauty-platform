import type { Request, Response } from 'express';

export const REFRESH_COOKIE = 'bp_refresh';
/** The cookie is only sent to auth endpoints, never to the rest of the API. */
const COOKIE_PATH = '/v1/auth';

export function setRefreshCookie(
  res: Response,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}

/** Reads the refresh cookie without a cookie-parser dependency. */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}
