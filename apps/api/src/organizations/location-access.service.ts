import { Injectable } from '@nestjs/common';
import { forbidden, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Location } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The single place that decides whether a member may see or change a location.
 * Owners: every location of their organization. Managers and staff: only assigned ones.
 * Outside that → 404 (the location "does not exist" for them).
 */
@Injectable()
export class LocationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async readable(membership: MembershipContext, locationId: string): Promise<Location> {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, organizationId: membership.organizationId },
    });
    if (!location) {
      throw notFound('Location');
    }
    if (membership.role !== 'owner' && !membership.locationIds.includes(location.id)) {
      throw notFound('Location');
    }
    return location;
  }

  /** Owners and the location's managers may change its settings, services, staff and schedules. */
  async writable(membership: MembershipContext, locationId: string): Promise<Location> {
    const location = await this.readable(membership, locationId);
    if (membership.role === 'staff') {
      throw forbidden();
    }
    return location;
  }
}
