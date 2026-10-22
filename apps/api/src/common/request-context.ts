import type { Request } from 'express';
import type { MembershipRole } from '../generated/prisma/client';

export interface AuthContext {
  userId: string;
  sessionId: string;
}

export interface MembershipContext {
  membershipId: string;
  organizationId: string;
  role: MembershipRole;
  /** Locations a manager or staff member is limited to. Empty for owners (they see all). */
  locationIds: string[];
}

/** Request after the auth guard (and, for organization routes, the membership guard). */
export type AppRequest = Request & {
  auth?: AuthContext;
  membership?: MembershipContext;
};
