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
  ServiceStaffOffersInput,
  UpdateServiceCategoryInput,
  UpdateServiceInput,
  UpdateStaffInput,
} from './scheduling.schemas';
import type {
  ServiceCategoryResponse,
  ServiceResponse,
  StaffResponse,
} from './scheduling.responses';

export type {
  ServiceCategoryResponse,
  ServiceResponse,
  StaffResponse,
} from './scheduling.responses';

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

const versionConflict = (what: string): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    `The ${what} was changed by someone else. Reload and try again`,
  );

function toService(service: ServiceWithStaff): ServiceResponse {
  const { staff, ...rest } = service;
  return {
    ...rest,
    staffIds: staff.map((s) => s.staffId).sort(),
    staffOffers: staff
      .filter((s) => s.priceGrosze !== null || s.durationMinutes !== null)
      .map((s) => ({
        staffId: s.staffId,
        priceGrosze: s.priceGrosze,
        durationMinutes: s.durationMinutes,
      }))
      .sort((a, b) => a.staffId.localeCompare(b.staffId)),
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

const withStaff = {
  staff: { select: { staffId: true, priceGrosze: true, durationMinutes: true } },
} as const;

type ServiceWithStaff = Service & {
  staff: { staffId: string; priceGrosze: number | null; durationMinutes: number | null }[];
};

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
      include: withStaff,
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
    await this.findService(locationId, serviceId);
    return toService(
      await this.prisma.service.findUniqueOrThrow({
        where: { id: serviceId },
        include: withStaff,
      }),
    );
  }

  async createService(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    input: CreateServiceInput,
  ): Promise<ServiceResponse> {
    await this.access.writable(m, locationId);
    await this.assertCategory(locationId, input.categoryId);
    const { staffIds, ...fields } = input;
    const staff = [...new Set(staffIds ?? [])];
    await this.assertStaffInLocation(locationId, staff);
    const service = await this.prisma.$transaction(async (tx) => {
      const created = await tx.service.create({ data: { ...fields, locationId } });
      await tx.staffService.createMany({
        data: staff.map((staffId) => ({ staffId, serviceId: created.id })),
      });
      await this.record(tx, m, actorUserId, 'service.created', 'service', created.id);
      return tx.service.findUniqueOrThrow({ where: { id: created.id }, include: withStaff });
    });
    return toService(service);
  }

  /**
   * Deletes a service that was never used (owner test T3). A service with visits (any status,
   * also cancelled — they keep the history) or named in a loyalty reward or coupon can only
   * be hidden: 409 SERVICE_IN_USE.
   */
  async deleteService(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    serviceId: string,
  ): Promise<void> {
    await this.access.writable(m, locationId);
    await this.findService(locationId, serviceId);
    const inUse = (details: { appointments: number; loyalty: number }) =>
      new AppException(
        HttpStatus.CONFLICT,
        'SERVICE_IN_USE',
        'The service has visits or is part of a loyalty reward; hide it instead',
        [
          { path: 'appointments', message: String(details.appointments) },
          { path: 'loyalty', message: String(details.loyalty) },
        ],
      );
    await this.prisma.$transaction(async (tx) => {
      // Lock the row: a booking for it cannot slip in between the check and the delete.
      await tx.$queryRaw`SELECT id FROM service WHERE id = ${serviceId}::uuid FOR UPDATE`;
      // One after another: a transaction runs on one connection.
      const appointments = await tx.appointment.count({ where: { serviceId } });
      const usedIn = { OR: [{ freeServiceId: serviceId }, { serviceIds: { has: serviceId } }] };
      const rewards = await tx.loyaltyReward.count({ where: usedIn });
      const coupons = await tx.loyaltyCoupon.count({ where: usedIn });
      if (appointments + rewards + coupons > 0) {
        throw inUse({ appointments, loyalty: rewards + coupons });
      }
      await tx.service.delete({ where: { id: serviceId } });
      await this.record(tx, m, actorUserId, 'service.deleted', 'service', serviceId);
    });
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
      return tx.service.findUniqueOrThrow({ where: { id: serviceId }, include: withStaff });
    });
    return toService(service);
  }

  /**
   * Replaces the set of specialists who perform this service (owner test T5): a new service
   * is bookable online only once someone performs it, so the service window asks "who?".
   */
  async setServiceStaff(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    serviceId: string,
    staffIds: string[],
  ): Promise<ServiceResponse> {
    await this.access.writable(m, locationId);
    await this.findService(locationId, serviceId);
    const unique = [...new Set(staffIds)];
    await this.assertStaffInLocation(locationId, unique);
    const service = await this.prisma.$transaction(async (tx) => {
      // Only the removed links go, so specialists who stay keep their own price (task 70).
      await tx.staffService.deleteMany({ where: { serviceId, staffId: { notIn: unique } } });
      await tx.staffService.createMany({
        data: unique.map((staffId) => ({ staffId, serviceId })),
        skipDuplicates: true,
      });
      await this.record(tx, m, actorUserId, 'service.staff_set', 'service', serviceId);
      return tx.service.findUniqueOrThrow({ where: { id: serviceId }, include: withStaff });
    });
    return toService(service);
  }

  /**
   * Task 70: specialists' own price and duration of this service (null = as the service says).
   * Each listed specialist must already perform the service.
   */
  async setServiceStaffOffers(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    serviceId: string,
    input: ServiceStaffOffersInput,
  ): Promise<ServiceResponse> {
    await this.access.writable(m, locationId);
    await this.findService(locationId, serviceId);
    const service = await this.prisma.$transaction(async (tx) => {
      for (const offer of input.offers) {
        const updated = await tx.staffService.updateMany({
          where: { serviceId, staffId: offer.staffId, staff: { locationId } },
          data: { priceGrosze: offer.priceGrosze, durationMinutes: offer.durationMinutes },
        });
        if (updated.count !== 1) {
          throw new AppException(
            HttpStatus.BAD_REQUEST,
            'STAFF_SERVICE_MISMATCH',
            'This staff member does not offer this service',
          );
        }
      }
      await this.record(tx, m, actorUserId, 'service.staff_offers_set', 'service', serviceId);
      return tx.service.findUniqueOrThrow({ where: { id: serviceId }, include: withStaff });
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
      // Only the removed links go, so services that stay keep this specialist's price (task 70).
      await tx.staffService.deleteMany({ where: { staffId, serviceId: { notIn: unique } } });
      await tx.staffService.createMany({
        data: unique.map((serviceId) => ({ staffId, serviceId })),
        skipDuplicates: true,
      });
      await this.record(tx, m, actorUserId, 'staff.services_set', 'staff_member', staffId);
      return tx.staffMember.findUniqueOrThrow({ where: { id: staffId }, include: withServices });
    });
    return toStaff(staff);
  }

  /**
   * Task 13: the owner puts the staff in the order clients see them (booking page, apps,
   * calendar). The list must name every staff member of the location exactly once.
   */
  async reorderStaff(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffIds: string[],
  ): Promise<StaffResponse[]> {
    await this.access.writable(m, locationId);
    const staff = await this.prisma.staffMember.findMany({
      where: { locationId },
      select: { id: true, sortOrder: true },
    });
    const known = new Set(staff.map((s) => s.id));
    if (
      new Set(staffIds).size !== staffIds.length ||
      staffIds.length !== known.size ||
      staffIds.some((id) => !known.has(id))
    ) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Incomplete order', [
        { path: 'staffIds', message: 'list every staff member of this location exactly once' },
      ]);
    }
    const current = new Map(staff.map((s) => [s.id, s.sortOrder]));
    await this.prisma.$transaction(async (tx) => {
      for (const [index, id] of staffIds.entries()) {
        const sortOrder = index * 10;
        if (current.get(id) === sortOrder) continue;
        await tx.staffMember.update({
          where: { id },
          data: { sortOrder, version: { increment: 1 } },
        });
      }
      await this.record(tx, m, actorUserId, 'staff.reordered', 'location', locationId);
    });
    return this.listStaff(m, locationId);
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

  /** Staff of another location (or organization) are rejected, never linked. */
  private async assertStaffInLocation(locationId: string, staffIds: string[]): Promise<void> {
    if (staffIds.length === 0) return;
    const count = await this.prisma.staffMember.count({
      where: { id: { in: staffIds }, locationId },
    });
    if (count !== new Set(staffIds).size) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Unknown staff member', [
        { path: 'staffIds', message: 'every staff member must belong to this location' },
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
