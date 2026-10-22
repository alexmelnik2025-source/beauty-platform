import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../common/app-exception';
import type { AppRequest } from '../common/request-context';
import { AccessTokenService } from './access-token.service';
import { IS_PUBLIC } from './decorators';

/** Global guard: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const header = request.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    const auth = scheme === 'Bearer' && token ? this.tokens.verify(token) : null;
    if (!auth) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED',
        'Missing, invalid or expired access token',
      );
    }
    request.auth = auth;
    return true;
  }
}
