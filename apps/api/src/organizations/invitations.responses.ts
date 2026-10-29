import { z } from 'zod';
import { responseSchema } from '../common/openapi';

const invitationRole = z.enum(['manager', 'staff']);
const invitationStatus = z.enum(['pending', 'accepted', 'revoked', 'expired']);

export const invitationSchema = responseSchema(
  'Invitation',
  z.strictObject({
    id: z.string(),
    email: z.string(),
    role: invitationRole,
    locationIds: z.array(z.string()),
    staffMemberId: z.string().nullable(),
    staffCategoryId: z.string().nullable(),
    status: invitationStatus,
    expiresAt: z.string(),
    createdAt: z.string(),
  }),
);
export const invitationListSchema = responseSchema('InvitationList', z.array(invitationSchema));
export const invitationPreviewSchema = responseSchema(
  'InvitationPreview',
  z.strictObject({
    organizationName: z.string(),
    role: invitationRole,
    email: z.string(),
    status: invitationStatus,
    expiresAt: z.string(),
  }),
);
export const invitationAcceptedSchema = responseSchema(
  'InvitationAccepted',
  z.strictObject({ organizationId: z.string(), role: invitationRole }),
);
