import { z } from 'zod';
import type { MembershipRole } from '../generated/prisma/client';

/**
 * What a staff member (role "staff") may do beyond the basics. The basics are
 * always allowed: their own appointments with the client's name, the service,
 * date, time and status, and their own schedule (read only).
 *
 * Effective value = personal override ?? category value ?? default.
 * Owners and managers have every permission; the checks happen on the server
 * (data a staff member may not see is left out of the response).
 */
export const PERMISSIONS = {
  createOwnAppointments: true,
  changeOwnAppointments: true,
  bookOutsideHours: false,
  blockOwnTime: false,
  viewClientContacts: false,
  viewClientHistory: false,
  viewClientNotes: false,
  editClientNotes: false,
  viewAllAppointments: false,
  manageAllAppointments: false,
  viewOwnEarnings: false,
} as const satisfies Record<string, boolean>;

export type Permission = keyof typeof PERMISSIONS;
export type Permissions = Record<Permission, boolean>;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

/** { permission: boolean } with only known keys; used for categories and overrides. */
export const permissionMapSchema = z
  .object(
    Object.fromEntries(PERMISSION_KEYS.map((key) => [key, z.boolean().optional()])) as Record<
      Permission,
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict();

export type PermissionMap = Partial<Record<Permission, boolean>>;

/** Reads a stored JSON map defensively: unknown keys and non-booleans are ignored. */
export function readPermissionMap(value: unknown): PermissionMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const map: PermissionMap = {};
  for (const key of PERMISSION_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'boolean') map[key] = v;
  }
  return map;
}

export function effectivePermissions(
  role: MembershipRole,
  category: PermissionMap | null,
  overrides: PermissionMap,
): Permissions {
  const result = {} as Permissions;
  for (const key of PERMISSION_KEYS) {
    result[key] = role === 'staff' ? (overrides[key] ?? category?.[key] ?? PERMISSIONS[key]) : true;
  }
  return result;
}
