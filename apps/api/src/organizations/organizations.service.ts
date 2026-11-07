import { wishQuestions } from '../booking/visit-wishes';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AppException } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Location, MembershipRole, Organization } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateLocationInput,
  CreateOrganizationInput,
  UpdateLocationInput,
  UpdateOrganizationInput,
} from './organizations.schemas';
import { BOOKING_TERMS_TEMPLATE_PL, PRIVACY_POLICY_TEMPLATE_PL } from './legal-templates';
import { LocationAccessService } from './location-access.service';
import { slugify } from './slug';
import type {
  LegalTemplatesResponse,
  LocationResponse,
  OrganizationResponse,
} from './organizations.responses';

export type {
  LegalTemplatesResponse,
  LocationResponse,
  OrganizationResponse,
} from './organizations.responses';

/** Six lowercase letters and digits for a booking link ending (36^6 ≈ 2 billion). */
function randomSuffix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join('');
}

const slugTaken = (): AppException =>
  new AppException(HttpStatus.CONFLICT, 'SLUG_TAKEN', 'This booking link is already taken');

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

function assertCoordinatePair(fields: {
  latitude?: number | null;
  longitude?: number | null;
}): void {
  if ((fields.latitude === undefined) !== (fields.longitude === undefined)) {
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Latitude and longitude must be provided together',
    );
  }
}

const legalTextsRequired = (): AppException =>
  new AppException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'LEGAL_TEXTS_REQUIRED',
    'Write the booking terms and the privacy policy before switching online booking on',
  );

/**
 * Online booking needs the salon's booking terms and privacy policy: they cannot be missing when
 * booking is being switched on, nor be removed while it is on. Salons that were already taking
 * bookings before the texts existed keep working until they change either of these.
 */
function assertLegalTexts(
  before: Pick<Location, 'onlineBookingEnabled'> | null,
  after: Pick<Location, 'onlineBookingEnabled' | 'bookingTerms' | 'privacyPolicy'>,
  fields: { bookingTerms?: string | null; privacyPolicy?: string | null },
): void {
  if (!after.onlineBookingEnabled || (after.bookingTerms && after.privacyPolicy)) return;
  const switchingOn = !before?.onlineBookingEnabled;
  const removingText = fields.bookingTerms === null || fields.privacyPolicy === null;
  if (switchingOn || removingText) throw legalTextsRequired();
}

/** Placeholders like {KRS} that are still in a text, each once, in order. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Z_]+)\}/g)].map((m) => `{${m[1]}}`))];
}

function fillPlaceholders(text: string, values: Record<string, string | null>): string {
  return text.replace(/\{([A-Z_]+)\}/g, (match, key: string) => values[key] ?? match);
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
    drinks: wishQuestions({ ...location, askDrink: true }).drinks,
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
    assertCoordinatePair(input);
    const { slug: requestedSlug, ...fields } = input;
    const candidates = requestedSlug
      ? [requestedSlug]
      : [
          ...Array.from({ length: 20 }, (_, i) =>
            i === 0 ? slugify(input.name) : `${slugify(input.name)}-${i + 1}`,
          ),
          // Task 258: a common name ("Barber") taken 20 times still gets a link — a random ending.
          ...Array.from({ length: 5 }, () => `${slugify(input.name)}-${randomSuffix()}`),
        ];

    for (const slug of candidates) {
      try {
        const location = await this.prisma.$transaction(async (tx) => {
          const created = await tx.location.create({
            data: { ...fields, slug, organizationId: membership.organizationId },
          });
          assertLegalTexts(null, created, fields);
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
    assertCoordinatePair(fields);
    try {
      const location = await this.prisma.$transaction(async (tx) => {
        const before = await tx.location.findUnique({
          where: { id: locationId },
          select: { onlineBookingEnabled: true },
        });
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
        const after = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
        assertLegalTexts(before, after, fields);
        return after;
      });
      return toLocation(location);
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
  }
  /**
   * The Polish templates of docs/legal with what the platform already knows about the salon
   * filled in. Nothing is saved: the salon reads, completes and saves the texts itself.
   */
  async legalTemplates(
    membership: MembershipContext,
    locationId: string,
  ): Promise<LegalTemplatesResponse> {
    const location = await this.access.writable(membership, locationId);
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: membership.organizationId },
    });
    const deadline = location.clientCancelDeadlineMinutes;
    const values: Record<string, string | null> = {
      NAZWA_SALONU: location.name,
      ADRES_SALONU: `${location.addressLine}, ${location.postalCode} ${location.city}`,
      NAZWA_FIRMY: org.name,
      NIP: org.nip,
      TELEFON: location.phone,
      EMAIL: location.email,
      GODZINY_PRZED: deadline > 0 && deadline % 60 === 0 ? String(deadline / 60) : null,
      LINK_POLITYKA: `${this.config.APP_WEB_URL}/pl/b/${location.slug}/privacy`,
    };
    const bookingTerms = fillPlaceholders(BOOKING_TERMS_TEMPLATE_PL, values);
    const privacyPolicy = fillPlaceholders(PRIVACY_POLICY_TEMPLATE_PL, values);
    return {
      bookingTerms,
      privacyPolicy,
      missing: placeholdersIn(`${bookingTerms}\n${privacyPolicy}`),
    };
  }
}
