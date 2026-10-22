import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { Prisma, Service, StaffMember } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateServiceInput,
  CreateStaffInput,
  UpdateServiceInput,
  UpdateStaffInput,
} from './scheduling.schemas';

export type ServiceResponse = Omit<Service, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

export type StaffResponse = Omit<StaffMember, 'createdAt' | 'updatedAt'> & {
  serviceIds: string[];
  createdAt: string;
  updatedAt: string;
};

const versionConflict = (what: string): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    `The ${what} was changed by someone else. Reload and try again`,
  );

function toService(service: Service): ServiceResponse {
  return {
    ...service,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}

function toStaff(staff: StaffMember & { services: { serviceId: string }[] }): StaffResponse {
  const { services, ...rest } = staff;
  return {
    ...rest,
    serviceIds: services.map((s) => s.serviceId).sort(),
    createdAt: staff.createdAt.toISOString(),
    updatedAt: staff.updatedAt.toISOString(),
  };
}

const withServices = { services: { select: { serviceId: true } } } as const;

/** Services and staff of a location. Reads: any member with access; writes: owner or manager. */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
  ) {}

  // ── Services ───────────────────────────────────────────

  async listServices(m: MembershipContext, locationId: string): Promise<ServiceResponse[]> {
    await this.access.readable(m, locationId);
    const services = await this.prisma.service.findMany({
      where: { locationId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return services.map(toService);
  }

  async getService(m: MembershipContext, locationId: string, serviceId: string): Promise<ServiceResponse> {
    await this.access.readable(m, locationId);
    return toService(await this.findService(locationId, serviceId));
  }

  async createService(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    input: CreateServiceInput,
  ): Promise<ServiceResponse> {
    await this.access.writable(m, locationId);
    const service = await this.prisma.$transaction(async (tx) => {
      const created = await tx.service.create({ data: { ...input, locationId } });
      await this.record(tx, m, actorUserId, 'service.created', 'service', created.id);
      return created;
    });
    return toService(service);
  }

  /** Changing price or duration never affects existing appointments (they keep a snapshot). */
  async updateService(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    serviceId: string,
    input: UpdateServiceInput,
  ): Promise<ServiceResponse> {
    await this.access.writable(m, locationId);
    await this.findService(locationId, serviceId);
    const { version, ...fields } = input;
    const service = await this.prisma.$transaction(async (tx) => {
      const result = await tx.service.updateMany({
        where: { id: serviceId, locationId, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (result.count !== 1) throw versionConflict('service');
      await this.record(tx, m, actorUserId, 'service.updated', 'service', serviceId, Object.keys(fields));
      return tx.service.findUniqueOrThrow({ where: { id: serviceId } });
    });
    return toService(service);
  }

  // ── Staff ──────────────────────────────────────────────

  async listStaff(m: MembershipContext, locationId: string): Promise<StaffResponse[]> {
    await this.access.readable(m, locationId);
    const staff = await this.prisma.staffMember.findMany({
      where: { locationId },
      include: withServices,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return staff.map(toStaff);
  }

  async getStaff(m: MembershipContext, locationId: string, staffId: string): Promise<StaffResponse> {
    await this.access.readable(m, locationId);
    return toStaff(await this.findStaff(locationId, staffId));
  }

  async createStaff(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    input: CreateStaffInput,
  ): Promise<StaffResponse> {
    await this.access.writable(m, locationId);
    const { serviceIds, ...fields } = input;
    await this.assertServicesInLocation(locationId, serviceIds);
    const staff = await this.prisma.$transaction(async (tx) => {
      const created = await tx.staffMember.create({
        data: {
          ...fields,
          locationId,
          services: { create: serviceIds.map((serviceId) => ({ serviceId })) },
        },
        include: withServices,
      });
      await this.record(tx, m, actorUserId, 'staff.created', 'staff_member', created.id);
      return created;
    });
    return toStaff(staff);
  }

  async updateStaff(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    input: UpdateStaffInput,
  ): Promise<StaffResponse> {
    await this.access.writable(m, locationId);
    await this.findStaff(locationId, staffId);
    const { version, ...fields } = input;
    const staff = await this.prisma.$transaction(async (tx) => {
      const result = await tx.staffMember.updateMany({
        where: { id: staffId, locationId, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (result.count !== 1) throw versionConflict('staff member');
      await this.record(tx, m, actorUserId, 'staff.updated', 'staff_member', staffId, Object.keys(fields));
      return tx.staffMember.findUniqueOrThrow({ where: { id: staffId }, include: withServices });
    });
    return toStaff(staff);
  }

  /** Replaces the set of services this staff member performs. */
  async setStaffServices(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    serviceIds: string[],
  ): Promise<StaffResponse> {
    await this.access.writable(m, locationId);
    await this.findStaff(locationId, staffId);
    const unique = [...new Set(serviceIds)];
    await this.assertServicesInLocation(locationId, unique);
    const staff = await this.prisma.$transaction(async (tx) => {
      await tx.staffService.deleteMany({ where: { staffId } });
      await tx.staffService.createMany({ data: unique.map((serviceId) => ({ staffId, serviceId })) });
      await this.record(tx, m, actorUserId, 'staff.services_set', 'staff_member', staffId);
      return tx.staffMember.findUniqueOrThrow({ where: { id: staffId }, include: withServices });
    });
    return toStaff(staff);
  }

  // ── Helpers (also used by the schedule service) ────────

  async findService(locationId: string, serviceId: string): Promise<Service> {
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, locationId } });
    if (!service) throw notFound('Service');
    return service;
  }

  async findStaff(
    locationId: string,
    staffId: string,
  ): Promise<StaffMember & { services: { serviceId: string }[] }> {
    const staff = await this.prisma.staffMember.findFirst({
      where: { id: staffId, locationId },
      include: withServices,
    });
    if (!staff) throw notFound('Staff member');
    return staff;
  }

  /** Services from another location (or organization) are rejected, never linked. */
  private async assertServicesInLocation(locationId: string, serviceIds: string[]): Promise<void> {
    if (serviceIds.length === 0) return;
    const count = await this.prisma.service.count({ where: { id: { in: serviceIds }, locationId } });
    if (count !== new Set(serviceIds).size) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Unknown service', [
        { path: 'serviceIds', message: 'every service must belong to this location' },
      ]);
    }
  }

  private record(
    tx: Prisma.TransactionClient,
    m: MembershipContext,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    fields?: string[],
  ): Promise<void> {
    return this.audit.record(
      {
        organizationId: m.organizationId,
        actorUserId,
        action,
        entityType,
        entityId,
        ...(fields ? { metadata: { fields } } : {}),
      },
      tx,
    );
  }
}
