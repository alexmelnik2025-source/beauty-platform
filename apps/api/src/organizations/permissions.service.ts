import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { Membership, Prisma, StaffCategory, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  effectivePermissions,
  PERMISSION_KEYS,
  PERMISSIONS,
  permissionMapSchema,
  readPermissionMap,
  type Permission,
  type PermissionMap,
  type Permissions,
} from './permissions';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  permissions: permissionMapSchema.default({}),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(60).optional(),
  /** Replaces the whole map; a missing key means "use the default". */
  permissions: permissionMapSchema.optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const setMemberPermissionsSchema = z.object({
  version: z.number().int().min(1),
  staffCategoryId: z.uuid().nullable(),
  /** Personal exceptions; replaces the whole map. A missing key means "as in the category". */
  overrides: permissionMapSchema.default({}),
});
export type SetMemberPermissionsInput = z.infer<typeof setMemberPermissionsSchema>;

export interface PermissionCatalogResponse {
  permissions: { key: Permission; default: boolean }[];
  /** What the caller may do in this organization (for showing or hiding parts of the interface). */
  me: { role: Membership['role']; permissions: Permissions };
}

export interface CategoryResponse {
  id: string;
  name: string;
  permissions: PermissionMap;
  memberCount: number;
  version: number;
}

export interface MemberResponse {
  membershipId: string;
  user: { id: string; name: string; email: string };
  role: Membership['role'];
  status: Membership['status'];
  locationIds: string[];
  staffCategoryId: string | null;
  overrides: PermissionMap;
  permissions: Permissions;
  version: number;
}

const versionConflict = (what: string): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    `The ${what} was changed by someone else. Reload and try again`,
  );

const nameTaken = (): AppException =>
  new AppException(HttpStatus.CONFLICT, 'CATEGORY_NAME_TAKEN', 'A category with this name exists');

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

type LoadedMember = Membership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
  locations: { locationId: string }[];
  staffCategory: StaffCategory | null;
};

const memberInclude = {
  user: { select: { id: true, name: true, email: true } },
  locations: { select: { locationId: true } },
  staffCategory: true,
} as const;

/** Staff categories and personal permission exceptions, managed by the owner. */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  catalog(m: MembershipContext): PermissionCatalogResponse {
    return {
      permissions: PERMISSION_KEYS.map((key) => ({ key, default: PERMISSIONS[key] })),
      me: { role: m.role, permissions: m.permissions },
    };
  }

  async listCategories(m: MembershipContext): Promise<CategoryResponse[]> {
    const rows = await this.prisma.staffCategory.findMany({
      where: { organizationId: m.organizationId },
      include: { _count: { select: { memberships: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => toCategory(row, row._count.memberships));
  }

  async createCategory(
    m: MembershipContext,
    actorUserId: string,
    input: CreateCategoryInput,
  ): Promise<CategoryResponse> {
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.staffCategory.create({
          data: {
            organizationId: m.organizationId,
            name: input.name,
            permissions: input.permissions as Prisma.InputJsonValue,
          },
        });
        await this.record(tx, m, actorUserId, 'staff_category.created', row.id, {
          name: row.name,
          permissions: input.permissions,
        });
        return row;
      });
      return toCategory(created, 0);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async updateCategory(
    m: MembershipContext,
    actorUserId: string,
    categoryId: string,
    input: UpdateCategoryInput,
  ): Promise<CategoryResponse> {
    await this.findCategory(m, categoryId);
    try {
      await this.prisma.$transaction(async (tx) => {
        const result = await tx.staffCategory.updateMany({
          where: { id: categoryId, organizationId: m.organizationId, version: input.version },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.permissions !== undefined
              ? { permissions: input.permissions as Prisma.InputJsonValue }
              : {}),
            version: { increment: 1 },
          },
        });
        if (result.count !== 1) throw versionConflict('category');
        await this.record(tx, m, actorUserId, 'staff_category.updated', categoryId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    const row = await this.prisma.staffCategory.findUniqueOrThrow({
      where: { id: categoryId },
      include: { _count: { select: { memberships: true } } },
    });
    return toCategory(row, row._count.memberships);
  }

  /** Members of a deleted category fall back to the defaults plus their own exceptions. */
  async deleteCategory(
    m: MembershipContext,
    actorUserId: string,
    categoryId: string,
  ): Promise<void> {
    await this.findCategory(m, categoryId);
    await this.prisma.$transaction(async (tx) => {
      await tx.staffCategory.delete({ where: { id: categoryId } });
      await this.record(tx, m, actorUserId, 'staff_category.deleted', categoryId);
    });
  }

  async listMembers(m: MembershipContext): Promise<MemberResponse[]> {
    const rows = await this.prisma.membership.findMany({
      where: {
        organizationId: m.organizationId,
        // Managers see the people of their own locations (and the owners).
        ...(m.role === 'owner'
          ? {}
          : {
              OR: [
                { role: 'owner' },
                { locations: { some: { locationId: { in: m.locationIds } } } },
              ],
            }),
      },
      include: memberInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toMember);
  }

  async setMemberPermissions(
    m: MembershipContext,
    actorUserId: string,
    membershipId: string,
    input: SetMemberPermissionsInput,
  ): Promise<MemberResponse> {
    const member = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId: m.organizationId },
    });
    if (!member) throw notFound('Member');
    if (member.role !== 'staff') {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'NOT_A_STAFF_MEMBER',
        'Categories and permissions apply to staff members only; owners and managers have full access',
      );
    }
    if (input.staffCategoryId) await this.findCategory(m, input.staffCategoryId);

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.membership.updateMany({
        where: { id: membershipId, version: input.version },
        data: {
          staffCategoryId: input.staffCategoryId,
          permissionOverrides: input.overrides as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw versionConflict('member');
      await this.record(tx, m, actorUserId, 'membership.permissions_changed', membershipId, {
        staffCategoryId: input.staffCategoryId,
        overrides: input.overrides,
      });
    });
    const updated = await this.prisma.membership.findUniqueOrThrow({
      where: { id: membershipId },
      include: memberInclude,
    });
    return toMember(updated);
  }

  private async findCategory(m: MembershipContext, categoryId: string): Promise<StaffCategory> {
    const category = await this.prisma.staffCategory.findFirst({
      where: { id: categoryId, organizationId: m.organizationId },
    });
    if (!category) throw notFound('Category');
    return category;
  }

  private record(
    tx: Prisma.TransactionClient,
    m: MembershipContext,
    actorUserId: string,
    action: string,
    entityId: string,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    return this.audit.record(
      {
        organizationId: m.organizationId,
        actorUserId,
        action,
        entityType: action.split('.')[0]!,
        entityId,
        metadata,
      },
      tx,
    );
  }
}

function toCategory(row: StaffCategory, memberCount: number): CategoryResponse {
  return {
    id: row.id,
    name: row.name,
    permissions: readPermissionMap(row.permissions),
    memberCount,
    version: row.version,
  };
}

function toMember(row: LoadedMember): MemberResponse {
  const overrides = readPermissionMap(row.permissionOverrides);
  return {
    membershipId: row.id,
    user: { id: row.user.id, name: row.user.name, email: row.user.email },
    role: row.role,
    status: row.status,
    locationIds: row.locations.map((l) => l.locationId),
    staffCategoryId: row.staffCategoryId,
    overrides,
    permissions: effectivePermissions(
      row.role,
      row.staffCategory ? readPermissionMap(row.staffCategory.permissions) : null,
      overrides,
    ),
    version: row.version,
  };
}
