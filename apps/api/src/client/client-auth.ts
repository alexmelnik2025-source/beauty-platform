import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../common/app-exception';
import type { AppRequest } from '../common/request-context';
import { ClientService, type ClientAuth } from './client.service';

export const CLIENT_COOKIE = 'bp_client';
/** The cookie is only sent to the client app endpoints, never to the salon API. */
const COOKIE_PATH = '/v1/client';

type ClientRequest = AppRequest & { client?: ClientAuth };

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

/** Web: the httpOnly cookie. Mobile: `Authorization: Bearer <token>`. */
export function readClientToken(req: Request): string | undefined {
  const [scheme, bearer] = (req.header('authorization') ?? '').split(' ');
  if (scheme === 'Bearer' && bearer) return bearer;
  const header = req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CLIENT_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Requires a signed-in client of the "My visits" app (separate from salon accounts). */
@Injectable()
export class ClientGuard implements CanActivate {
  constructor(private readonly clients: ClientService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ClientRequest>();
    const token = readClientToken(request);
    const auth = token ? await this.clients.authenticate(token) : null;
    if (!auth) {
      throw new AppException(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Sign in with an email code');
    }
    request.client = auth;
    return true;
  }
}

export const CurrentClient = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<ClientRequest>();
  if (!request.client) throw new Error('CurrentClient used without ClientGuard');
  return request.client;
});
