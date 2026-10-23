import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { notFound } from '../common/app-exception';
import type { AppRequest } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';

/** True when the user is a platform administrator (verified email listed in PLATFORM_ADMIN_EMAILS). */
export function isPlatformAdmin(
  config: AppConfig,
  user: { email: string; emailVerifiedAt: Date | null },
): boolean {
  return user.emailVerifiedAt !== null && config.PLATFORM_ADMIN_EMAILS.includes(user.email);
}

/**
 * Platform administration routes. Anyone else gets 404, so the routes cannot be
 * discovered by trying them.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.auth) throw notFound('Page');
    const user = await this.prisma.user.findUnique({ where: { id: request.auth.userId } });
    if (!user || !isPlatformAdmin(this.config, user)) throw notFound('Page');
    return true;
  }
}
