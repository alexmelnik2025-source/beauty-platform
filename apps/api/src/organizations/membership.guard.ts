import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { forbidden, notFound } from '../common/app-exception';
import type { AppRequest, MembershipContext } from '../common/request-context';
import type { MembershipRole } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const ROLES = 'membershipRoles';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Restricts a route to some roles. Without it, any active member may call the route. */
export const RequireRoles = (...roles: MembershipRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);

/** The caller's membership in the organization from the :orgId route parameter. */
export const CurrentMembership = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): MembershipContext => {
    const membership = ctx.switchToHttp().getRequest<AppRequest>().membership;
    if (!membership) {
      throw new Error('CurrentMembership used without MembershipGuard');
    }
    return membership;
  },
);

/**
 * Tenant isolation for every route under /organizations/:orgId.
 * Not a member (or a malformed id) → 404, so other organizations' ids cannot be probed.
 * Member with an insufficient role → 403.
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const orgId = request.params.orgId;
    if (!request.auth || typeof orgId !== 'string' || !UUID.test(orgId)) {
      throw notFound('Organization');
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: request.auth.userId, organizationId: orgId } },
      include: { locations: { select: { locationId: true } } },
    });
    if (!membership || membership.status !== 'active') {
      throw notFound('Organization');
    }

    const roles = this.reflector.getAllAndOverride<MembershipRole[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && !roles.includes(membership.role)) {
      throw forbidden();
    }

    request.membership = {
      membershipId: membership.id,
      organizationId: orgId,
      role: membership.role,
      locationIds: membership.role === 'owner' ? [] : membership.locations.map((l) => l.locationId),
    };
    return true;
  }
}
