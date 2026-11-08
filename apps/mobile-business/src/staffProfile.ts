import type { ServiceList, StaffList } from './api';

/**
 * Tasks 326–327: a specialist's profile in "Grafik zespołu" — the name clients see, a short
 * description, what they do (main specialty first), whether they take clients, and which
 * services they perform. No React Native here, so it is tested in Vitest
 * (test/staffProfile.test.ts). The server checks everything again.
 */

type Staff = StaffList[number];
export type Specialty = Staff['specialties'][number];

/** The list in the cabinet's order (apps/web/lib/types.ts). */
export const SPECIALTIES = [
  'hairdresser',
  'barber',
  'nails',
  'cosmetologist',
  'brows_lashes',
  'makeup',
  'massage',
] as const satisfies readonly Specialty[];
// A new value on the server must be added above, or this line fails to compile.
const _everySpecialty: Exclude<Specialty, (typeof SPECIALTIES)[number]> extends never
  ? true
  : never = true;
void _everySpecialty;

export interface StaffProfileForm {
  displayName: string;
  bio: string;
  specialties: Specialty[];
  customSpecialty: string;
  active: boolean;
  serviceIds: string[];
}

/** What PATCH …/staff/:id takes besides the version: only what changed. */
export interface StaffChange {
  displayName?: string;
  bio?: string | null;
  specialties?: Specialty[];
  customSpecialty?: string | null;
  active?: boolean;
}

export function profileForm(staff: Staff): StaffProfileForm {
  return {
    displayName: staff.displayName,
    bio: staff.bio ?? '',
    specialties: [...staff.specialties],
    customSpecialty: staff.customSpecialty ?? '',
    active: staff.active,
    serviceIds: [...staff.serviceIds],
  };
}

/** Pressing a specialty: off when it was on; otherwise added at the end (the first is the main one). */
export function toggleSpecialty(list: Specialty[], code: Specialty): Specialty[] {
  return list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
}

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

export type ProfileProblem = 'noName';

/**
 * What to send: the profile change (null = nothing) and the new list of services (null = the
 * same ones). The name may not be empty.
 */
export function profileChanges(
  staff: Staff,
  form: StaffProfileForm,
): { problem: ProfileProblem } | { change: StaffChange | null; serviceIds: string[] | null } {
  const name = form.displayName.trim();
  if (!name) return { problem: 'noName' };
  const change: StaffChange = {};
  if (name !== staff.displayName) change.displayName = name;
  const bio = form.bio.trim() || null;
  if (bio !== staff.bio) change.bio = bio;
  if (!sameList(form.specialties, staff.specialties)) change.specialties = form.specialties;
  const custom = form.customSpecialty.trim() || null;
  if (custom !== staff.customSpecialty) change.customSpecialty = custom;
  if (form.active !== staff.active) change.active = form.active;
  return {
    change: Object.keys(change).length > 0 ? change : null,
    serviceIds: sameSet(form.serviceIds, staff.serviceIds) ? null : form.serviceIds,
  };
}

/** The services to tick: the salon's offered ones, plus a hidden one this person still has. */
export function serviceChoices(services: ServiceList, serviceIds: string[]): ServiceList {
  return services.filter((s) => s.active || serviceIds.includes(s.id));
}

/**
 * Task 326: everyone in "Grafik zespołu" — those taking clients first, then the ones switched
 * off (so they can be switched back on); each group in the salon's order.
 */
export function teamForProfiles(staff: StaffList): StaffList {
  return [...staff].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      a.sortOrder - b.sortOrder ||
      a.displayName.localeCompare(b.displayName),
  );
}

/**
 * Task 329: the order after moving one specialist up (-1) or down (+1) in the shown list — every
 * id once, as PUT …/staff/order takes it; null at the top or the bottom.
 */
export function movedOrder(team: StaffList, id: string, delta: -1 | 1): string[] | null {
  const ids = team.map((s) => s.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}

/** Task 328: a new specialist goes to the end of the salon's order. */
export function nextSortOrder(team: StaffList): number {
  return team.reduce((max, s) => Math.max(max, s.sortOrder + 10), 0);
}
