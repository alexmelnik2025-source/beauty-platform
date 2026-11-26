import {
  ApiError,
  type Invitation,
  type InvitationList,
  type Locale,
  type MemberList,
  type NewInvitation,
  type StaffList,
} from './api';
import { normalizePhone } from './phone';

/**
 * "Zespół" in the business app (task 92): who has access to the salon, who is invited and
 * who still has no account — and the invitation form. No React Native here — tested in Vitest
 * (test/team.test.ts). The server checks every right again (a manager invites only specialists).
 */

export type Member = MemberList[number];
export type Specialist = StaffList[number];

/** One specialist profile of the calendar and how far their access is. */
export type SpecialistRow =
  | { staff: Specialist; state: 'account'; member: Member | null }
  | { staff: Specialist; state: 'invited'; invitation: Invitation }
  | { staff: Specialist; state: 'none' };

export interface Team {
  /** Active specialists, plus inactive profiles with an account or pending invitation to manage. */
  specialists: SpecialistRow[];
  /** Owners and managers of this salon (people with access but no specialist profile here). */
  managers: Member[];
  /** Pending invitations not tied to a specialist profile (managers, new specialists). */
  invitations: Invitation[];
}

const pending = (i: Invitation) => i.status === 'pending';
const ofSalon = (locationId: string) => (m: Member) =>
  m.role === 'owner' || m.locationIds.includes(locationId);

/** Puts the three lists of the API together for one salon. */
export function teamOf(
  staff: StaffList,
  members: MemberList,
  invitations: InvitationList,
  locationId: string,
): Team {
  const salonMembers = members.filter(ofSalon(locationId));
  const waiting = invitations.filter((i) => pending(i) && i.locationIds.includes(locationId));
  const byUser = new Map(salonMembers.map((m) => [m.user.id, m]));
  const invitedProfiles = new Set(waiting.map((invitation) => invitation.staffMemberId));
  const specialists: SpecialistRow[] = staff
    .filter((s) => s.active || (s.userId && byUser.has(s.userId)) || invitedProfiles.has(s.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s): SpecialistRow => {
      if (s.userId) return { staff: s, state: 'account', member: byUser.get(s.userId) ?? null };
      const invitation = waiting.find((i) => i.staffMemberId === s.id);
      return invitation ? { staff: s, state: 'invited', invitation } : { staff: s, state: 'none' };
    });
  const linkedUsers = new Set(staff.map((s) => s.userId).filter(Boolean));
  const tiedInvitations = new Set(staff.map((s) => s.id));
  const roleOrder = { owner: 0, manager: 1, staff: 2 } as const;
  return {
    specialists,
    managers: salonMembers
      .filter((m) => !linkedUsers.has(m.user.id))
      .sort(
        (a, b) => roleOrder[a.role] - roleOrder[b.role] || a.user.name.localeCompare(b.user.name),
      ),
    invitations: waiting.filter((i) => !(i.staffMemberId && tiedInvitations.has(i.staffMemberId))),
  };
}

/** Only the owner invites managers; a manager invites specialists (the server says the same). */
export function rolesToInvite(myRole: 'owner' | 'manager' | 'staff'): ('staff' | 'manager')[] {
  if (myRole === 'owner') return ['staff', 'manager'];
  if (myRole === 'manager') return ['staff'];
  return [];
}

/** Only the owner removes managers and specialists. */
export function mayRemove(myRole: 'owner' | 'manager' | 'staff', member: Member): boolean {
  return myRole === 'owner' && (member.role === 'manager' || member.role === 'staff');
}

export type InviteProblem = 'email' | 'phone';

/** Checks the form; the phone is optional and gets the salon's country code. */
export function inviteBody(
  form: { email: string; phone: string },
  options: {
    role: 'staff' | 'manager';
    locationId: string;
    staffMemberId: string | null;
    dial: string;
    locale: Locale;
  },
): { ok: true; body: NewInvitation } | { ok: false; problem: InviteProblem } {
  const email = form.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, problem: 'email' };
  const body: NewInvitation = {
    email,
    role: options.role,
    locationIds: [options.locationId],
    locale: options.locale,
  };
  if (form.phone.trim()) {
    const phone = normalizePhone(form.phone, options.dial);
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) return { ok: false, problem: 'phone' };
    body.phone = phone;
  }
  if (options.role === 'staff' && options.staffMemberId) body.staffMemberId = options.staffMemberId;
  return { ok: true, body };
}

export type InviteError = 'alreadyMember' | 'linked' | 'forbidden' | 'other';

/** What went wrong with an invitation, in words the owner understands. */
export function inviteError(error: unknown): InviteError {
  if (!(error instanceof ApiError)) return 'other';
  if (error.code === 'ALREADY_MEMBER') return 'alreadyMember';
  if (error.code === 'STAFF_ALREADY_LINKED') return 'linked';
  if (error.status === 403) return 'forbidden';
  return 'other';
}
