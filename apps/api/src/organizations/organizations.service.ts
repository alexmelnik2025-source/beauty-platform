import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { Location, MembershipRole, Organization } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateLocationInput,
  CreateOrganizationInput,
  UpdateLocationInput,
  UpdateOrganizationInput,
} from './organizations.schemas';
import { LocationAccessService } from './location-access.service';
import { slugify } from './slug';
import type { LocationResponse, OrganizationResponse } from './organizations.responses';

export type { LocationResponse, OrganizationResponse } from './organizations.responses';

const slugTaken = (): AppException =>
  new AppException(HttpStatus.CONFLICT, 'SLUG_TAKEN', 'This booking link is already taken');

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

function toOrganization(org: Organization, role: MembershipRole): OrganizationResponse {
  return {
    id: org.id,
    name: org.name,
    nip: org.nip,
    country: org.country,
    role,
    createdAt: org.createdAt.toISOString(),
  };
}

function toLocation(location: Location): LocationResponse {
  return {
    ...location,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  };
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: LocationAccessService,
  ) {}

  /** The creator becomes the owner. */
  async createOrganization(
    userId: string,
    input: CreateOrganizationInput,
  ): Promise<OrganizationResponse> {
    const organization = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: input.name, nip: input.nip } });
      await tx.membership.create({
        data: { userId, organizationId: org.id, role: 'owner', status: 'active' },
      });
      await this.audit.record(
        {
          organizationId: org.id,
          actorUserId: userId,
          action: 'organization.created',
          entityType: 'organization',
          entityId: org.id,
        },
        tx,
      );
      return org;
    });
    return toOrganization(organization, 'owner');
  }

  async listOrganizations(userId: string): Promise<OrganizationResponse[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'active' },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => toOrganization(m.organization, m.role));
  }

  async getOrganization(membership: MembershipContext): Promise<OrganizationResponse> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: membership.organizationId },
    });
    return toOrganization(org, membership.role);
  }

  async updateOrganization(
    membership: MembershipContext,
    actorUserId: string,
    input: UpdateOrganizationInput,
  ): Promise<OrganizationResponse> {
    const org = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.organization.update({
        where: { id: membership.organizationId },
        data: input,
      });
      await this.audit.record(
        {
          organizationId: updated.id,
          actorUserId,
          action: 'organization.updated',
          entityType: 'organization',
          entityId: updated.id,
          metadata: { fields: Object.keys(input) },
        },
        tx,
      );
      return updated;
    });
    return toOrganization(org, membership.role);
  }

  async createLocation(
    membership: MembershipContext,
    actorUserId: string,
    input: CreateLocationInput,
  ): Promise<LocationResponse> {
    const { slug: requestedSlug, ...fields } = input;
    const candidates = requestedSlug
      ? [requestedSlug]
      : Array.from({ length: 20 }, (_, i) =>
          i === 0 ? slugify(input.name) : `${slugify(input.name)}-${i + 1}`,
        );

    for (const slug of candidates) {
      try {
        const location = await this.prisma.$transaction(async (tx) => {
          const created = await tx.location.create({
            data: { ...fields, slug, organizationId: membership.organizationId },
          });
          await this.audit.record(
            {
              organizationId: membership.organizationId,
              actorUserId,
              action: 'location.created',
              entityType: 'location',
              entityId: created.id,
            },
            tx,
          );
          return created;
        });
        return toLocation(location);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw slugTaken();
  }

  /** Owners see every location; managers and staff only the ones they are assigned to. */
  async listLocations(membership: MembershipContext): Promise<LocationResponse[]> {
    const locations = await this.prisma.location.findMany({
      where: {
        organizationId: membership.organizationId,
        ...(membership.role === 'owner' ? {} : { id: { in: membership.locationIds } }),
      },
      orderBy: { createdAt: 'asc' },
    });
    return locations.map(toLocation);
  }

  async getLocation(membership: MembershipContext, locationId: string): Promise<LocationResponse> {
    return toLocation(await this.access.readable(membership, locationId));
  }

  /** Owners, and managers of this location. Rejects stale versions instead of overwriting. */
  async updateLocation(
    membership: MembershipContext,
    actorUserId: string,
    locationId: string,
    input: UpdateLocationInput,
  ): Promise<LocationResponse> {
    await this.access.writable(membership, locationId);

    const { version, ...fields } = input;
    try {
      const location = await this.prisma.$transaction(async (tx) => {
        const result = await tx.location.updateMany({
          where: { id: locationId, organizationId: membership.organizationId, version },
          data: { ...fields, version: { increment: 1 } },
        });
        if (result.count !== 1) {
          throw new AppException(
            HttpStatus.CONFLICT,
            'VERSION_CONFLICT',
            'The location was changed by someone else. Reload and try again',
          );
        }
        await this.audit.record(
          {
            organizationId: membership.organizationId,
            actorUserId,
            action: 'location.updated',
            entityType: 'location',
            entityId: locationId,
            metadata: { fields: Object.keys(fields) },
          },
          tx,
        );
        return tx.location.findUniqueOrThrow({ where: { id: locationId } });
      });
      return toLocation(location);
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
  }
}
