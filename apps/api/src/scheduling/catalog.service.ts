import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { Prisma, Service, ServiceCategory, StaffMember } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { photoUrl } from './photos.service';
import type {
  CreateServiceCategoryInput,
  CreateServiceInput,
  CreateStaffInput,
  UpdateServiceCategoryInput,
  UpdateServiceInput,
  UpdateStaffInput,
} from './scheduling.schemas';

export interface ServiceCategoryResponse {
  id: string;
  name: string;
  sortOrder: number;
  version: number;
}

const toCategory = (c: ServiceCategory): ServiceCategoryResponse => ({
  id: c.id,
  name: c.name,
  sortOrder: c.sortOrder,
  version: c.version,
});

const categoryNameTaken = (): AppException =>
  new AppException(HttpStatus.CONFLICT, 'CATEGORY_NAME_TAKEN', 'A category with this name exists');

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

export type ServiceResponse = Omit<Service, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

export type StaffResponse = Omit<StaffMember, 'createdAt' | 'updatedAt'> & {
  serviceIds: string[];
  /** The staff member's photo (/v1/public/photos/<id>); null when there is none. */
  photoUrl: string | null;
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

function toStaff(staff: StaffWithServices): StaffResponse {
  const { services, photo, ...rest } = staff;
  return {
    ...rest,
    serviceIds: services.map((s) => s.serviceId).sort(),
    photoUrl: photo ? photoUrl(photo.id) : null,
    createdAt: staff.createdAt.toISOString(),
    updatedAt: staff.updatedAt.toISOString(),
  };
}

const withServices = {
  services: { select: { serviceId: true } },
  photo: { select: { id: true } },
} as const;

type StaffWithServices = StaffMember & {
  services: { serviceId: string }[];
  photo: { id: string } | null;
};

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

  async getService(
    m: MembershipContext,
    locationId: string,
    serviceId: string,
  ): Promise<ServiceResponse> {
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
    await this.assertCategory(locationId, input.categoryId);
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
    await this.assertCategory(locationId, input.categoryId);
    const { version, ...fields } = input;
    const service = await this.prisma.$transaction(async (tx) => {
      const result = await tx.service.updateMany({
        where: { id: serviceId, locationId, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (result.count !== 1) throw versionConflict('service');
      await this.record(
        tx,
        m,
        actorUserId,
        'service.updated',
        'service',
        serviceId,
        Object.keys(fields),
      );
      return tx.service.findUniqueOrThrow({ where: { id: serviceId } });
    });
    return toService(service);
  }

  // ── Service categories ─────────────────────────────────

  async listCategories(
    m: MembershipContext,
    locationId: string,
  ): Promise<ServiceCategoryResponse[]> {
    await this.access.readable(m, locationId);
    const rows = await this.prisma.serviceCategory.findMany({
      where: { locationId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toCategory);
  }

  async createCategory(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    input: CreateServiceCategoryInput,
  ): Promise<ServiceCategoryResponse> {
    await this.access.writable(m, locationId);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.serviceCategory.create({ data: { ...input, locationId } });
        await this.record(
          tx,
          m,
          actorUserId,
          'service_category.created',
          'service_category',
          created.id,
        );
        return created;
      });
      return toCategory(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw categoryNameTaken();
      throw error;
    }
  }

  async updateCategory(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    categoryId: string,
    input: UpdateServiceCategoryInput,
  ): Promise<ServiceCategoryResponse> {
    await this.access.writable(m, locationId);
    await this.findCategory(locationId, categoryId);
    const { version, ...fields } = input;
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const result = await tx.serviceCategory.updateMany({
          where: { id: categoryId, locationId, version },
          data: { ...fields, version: { increment: 1 } },
        });
        if (result.count !== 1) throw versionConflict('category');
        await this.record(
          tx,
          m,
          actorUserId,
          'service_category.updated',
          'service_category',
          categoryId,
        );
        return tx.serviceCategory.findUniqueOrThrow({ where: { id: categoryId } });
      });
      return toCategory(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw categoryNameTaken();
      throw error;
    }
  }

  /** Its services stay, without a category. */
  async deleteCategory(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    categoryId: string,
  ): Promise<void> {
    await this.access.writable(m, locationId);
    await this.findCategory(locationId, categoryId);
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceCategory.delete({ where: { id: categoryId } });
      await this.record(
        tx,
        m,
        actorUserId,
        'service_category.deleted',
        'service_category',
        categoryId,
      );
    });
  }

  private async findCategory(locationId: string, categoryId: string): Promise<ServiceCategory> {
    const category = await this.prisma.serviceCategory.findFirst({
      where: { id: categoryId, locationId },
    });
    if (!category) throw notFound('Category');
    return category;
  }

  private async assertCategory(
    locationId: string,
    categoryId: string | null | undefined,
  ): Promise<void> {
    if (!categoryId) return;
    const count = await this.prisma.serviceCategory.count({
      where: { id: categoryId, locationId },
    });
    if (count === 0) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Unknown category', [
        { path: 'categoryId', message: 'the category must belong to this location' },
      ]);
    }
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

  async getStaff(
    m: MembershipContext,
    locationId: string,
    staffId: string,
  ): Promise<StaffResponse> {
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
    const { serviceIds: requested, ...fields } = input;
    const serviceIds = [...new Set(requested)];
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
      await this.record(
        tx,
        m,
        actorUserId,
        'staff.updated',
        'staff_member',
        staffId,
        Object.keys(fields),
      );
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
      await tx.staffService.createMany({
        data: unique.map((serviceId) => ({ staffId, serviceId })),
      });
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

  async findStaff(locationId: string, staffId: string): Promise<StaffWithServices> {
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
    const count = await this.prisma.service.count({
      where: { id: { in: serviceIds }, locationId },
    });
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
