import { ApiError, type MemberList, type PermissionCatalog, type StaffCategoryList } from './api';

/**
 * Tasks 330–331: "Uprawnienia" in the business app (owner) — what specialists with an account may
 * do. Effective value = the person's exception ?? their category's value ?? the default. No React
 * Native here, so it is tested in Vitest (test/rights.test.ts). The server checks everything again.
 */

export type PermissionKey = PermissionCatalog['permissions'][number]['key'];
export type PermissionMap = Partial<Record<PermissionKey, boolean>>;
type Member = MemberList[number];
type Category = StaffCategoryList[number];

/** A category being written: its name and every permission ticked or not. */
export interface CategoryForm {
  name: string;
  permissions: Record<PermissionKey, boolean>;
}

/** A new category starts from the defaults; an existing one from its values (defaults for the rest). */
export function categoryForm(
  category: Category | null,
  catalog: PermissionCatalog['permissions'],
): CategoryForm {
  const permissions = {} as Record<PermissionKey, boolean>;
  for (const p of catalog) {
    permissions[p.key] = (category?.permissions as PermissionMap | undefined)?.[p.key] ?? p.default;
  }
  return { name: category?.name ?? '', permissions };
}

/** What POST/PATCH …/staff-categories takes; the name may not be empty. */
export function categoryBody(
  form: CategoryForm,
): { ok: true; name: string; permissions: PermissionMap } | { ok: false } {
  const name = form.name.trim();
  if (!name) return { ok: false };
  return { ok: true, name, permissions: { ...form.permissions } };
}

/** One exception: as in the category (no key), yes or no. */
export type Exception = 'category' | 'yes' | 'no';

export function exceptionOf(overrides: PermissionMap, key: PermissionKey): Exception {
  const value = overrides[key];
  return value === undefined ? 'category' : value ? 'yes' : 'no';
}

export function withException(
  overrides: PermissionMap,
  key: PermissionKey,
  exception: Exception,
): PermissionMap {
  const next = { ...overrides };
  if (exception === 'category') delete next[key];
  else next[key] = exception === 'yes';
  return next;
}

/**
 * What the person may do with the chosen category and exceptions (shown next to each row before
 * saving): exception ?? category ?? default.
 */
export function effective(
  catalog: PermissionCatalog['permissions'],
  category: Category | null,
  overrides: PermissionMap,
): Record<PermissionKey, boolean> {
  const result = {} as Record<PermissionKey, boolean>;
  for (const p of catalog) {
    result[p.key] =
      overrides[p.key] ??
      (category?.permissions as PermissionMap | undefined)?.[p.key] ??
      p.default;
  }
  return result;
}

/** Specialists with an account in this salon, by name (owners and managers may do everything). */
export function specialistsWithAccess(members: MemberList, locationId: string): MemberList {
  return members
    .filter(
      (m) => m.role === 'staff' && m.status === 'active' && m.locationIds.includes(locationId),
    )
    .sort((a, b) => a.user.name.localeCompare(b.user.name));
}

const sameMap = (a: PermissionMap, b: PermissionMap) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<PermissionKey>;
  return [...keys].every((k) => a[k] === b[k]);
};

/** Nothing to send when the category and the exceptions are what the server has. */
export function memberUnchanged(
  member: Member,
  categoryId: string | null,
  overrides: PermissionMap,
): boolean {
  return member.staffCategoryId === categoryId && sameMap(member.overrides, overrides);
}

/** Someone else saved it meanwhile (the version did not match). */
export function changedMeanwhile(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'VERSION_CONFLICT';
}
