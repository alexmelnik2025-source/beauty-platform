import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthContext, AppRequest } from '../common/request-context';

export const IS_PUBLIC = 'isPublic';

/** Marks a route as reachable without signing in. Everything else requires an access token. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** The signed-in user and session (set by AuthGuard). */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();
    if (!request.auth) {
      throw new Error('CurrentAuth used on a public route');
    }
    return request.auth;
  },
);
