import { z } from 'zod';
import { membershipRoleSchema, membershipStatusSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';
import { PERMISSION_KEYS, permissionMapSchema, type Permission } from './permissions';

/** What the team page shows: permissions, staff categories, members and invitations. */

const permissionKeySchema = z.enum(PERMISSION_KEYS as [Permission, ...Permission[]]);

/** Every permission with its effective value. */
const permissionsSchema = z.strictObject(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, z.boolean()])) as Record<
    Permission,
    z.ZodBoolean
  >,
);

export const permissionCatalogSchema = responseSchema(
  'PermissionCatalog',
  z.strictObject({
    permissions: z.array(z.strictObject({ key: permissionKeySchema, default: z.boolean() })),
    me: z
      .strictObject({ role: membershipRoleSchema, permissions: permissionsSchema })
      .describe('What the caller may do here (for showing or hiding parts of the interface)'),
  }),
);
export type PermissionCatalogResponse = z.infer<typeof permissionCatalogSchema>;

export const staffCategorySchema = responseSchema(
  'StaffCategory',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    permissions: permissionMapSchema,
    memberCount: z.number().int(),
    version: z.number().int(),
  }),
);
export type CategoryResponse = z.infer<typeof staffCategorySchema>;

export const staffCategoryListSchema = responseSchema(
  'StaffCategoryList',
  z.array(staffCategorySchema),
);

export const memberSchema = responseSchema(
  'Member',
  z.strictObject({
    membershipId: z.string(),
    user: z.strictObject({ id: z.string(), name: z.string(), email: z.string() }),
    role: membershipRoleSchema,
    status: membershipStatusSchema,
    locationIds: z.array(z.string()),
    staffCategoryId: z.string().nullable(),
    overrides: permissionMapSchema.describe('Personal exceptions over the category'),
    permissions: permissionsSchema.describe('Effective: override, else category, else default'),
    version: z.number().int(),
  }),
);
export type MemberResponse = z.infer<typeof memberSchema>;

export const memberListSchema = responseSchema('MemberList', z.array(memberSchema));

const invitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired']);

export const invitationSchema = responseSchema(
  'Invitation',
  z.strictObject({
    id: z.string(),
    email: z.string(),
    role: membershipRoleSchema,
    locationIds: z.array(z.string()),
    staffMemberId: z.string().nullable(),
    staffCategoryId: z.string().nullable(),
    status: invitationStatusSchema,
    expiresAt: z.string(),
    createdAt: z.string(),
  }),
);
export type InvitationResponse = z.infer<typeof invitationSchema>;

export const invitationListSchema = responseSchema('InvitationList', z.array(invitationSchema));

export const invitationPreviewSchema = responseSchema(
  'InvitationPreview',
  z.strictObject({
    organizationName: z.string(),
    role: membershipRoleSchema,
    email: z.string(),
    status: invitationStatusSchema,
    expiresAt: z.string(),
  }),
);
export type InvitationPreviewResponse = z.infer<typeof invitationPreviewSchema>;

export const invitationAcceptedSchema = responseSchema(
  'InvitationAccepted',
  z.strictObject({ organizationId: z.string(), role: membershipRoleSchema }),
);
export type InvitationAcceptedResponse = z.infer<typeof invitationAcceptedSchema>;
