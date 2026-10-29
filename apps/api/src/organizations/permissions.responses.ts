import { z } from 'zod';
import { membershipRoleSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';
import { PERMISSION_KEYS } from './permissions';

const permissions = z.strictObject(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, z.boolean()])) as Record<
    (typeof PERMISSION_KEYS)[number],
    z.ZodBoolean
  >,
);
const permissionMap = z.strictObject(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, z.boolean().optional()])) as Record<
    (typeof PERMISSION_KEYS)[number],
    z.ZodOptional<z.ZodBoolean>
  >,
);

export const permissionCatalogSchema = responseSchema(
  'PermissionCatalog',
  z.strictObject({
    permissions: z.array(z.strictObject({ key: z.enum(PERMISSION_KEYS), default: z.boolean() })),
    me: z.strictObject({ role: membershipRoleSchema, permissions }),
  }),
);
export const staffCategorySchema = responseSchema(
  'StaffCategory',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    permissions: permissionMap,
    memberCount: z.number().int(),
    version: z.number().int(),
  }),
);
export const staffCategoryListSchema = responseSchema(
  'StaffCategoryList',
  z.array(staffCategorySchema),
);
export const teamMemberSchema = responseSchema(
  'TeamMember',
  z.strictObject({
    membershipId: z.string(),
    user: z.strictObject({ id: z.string(), name: z.string(), email: z.string() }),
    role: membershipRoleSchema,
    status: z.enum(['invited', 'active']),
    locationIds: z.array(z.string()),
    staffCategoryId: z.string().nullable(),
    overrides: permissionMap,
    permissions,
    version: z.number().int(),
  }),
);
export const teamMemberListSchema = responseSchema('TeamMemberList', z.array(teamMemberSchema));
