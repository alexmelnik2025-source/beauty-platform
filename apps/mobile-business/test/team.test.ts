import { describe, expect, it } from 'vitest';
import { ApiError, type InvitationList, type MemberList, type StaffList } from '../src/api';
import { inviteBody, inviteError, mayRemove, rolesToInvite, teamOf } from '../src/team';

const LOC = 'loc-1';

const staff = (id: string, name: string, userId: string | null, sortOrder = 0, active = true) =>
  ({ id, displayName: name, userId, sortOrder, active, locationId: LOC }) as StaffList[number];

const member = (
  membershipId: string,
  userId: string,
  name: string,
  role: 'owner' | 'manager' | 'staff',
  locationIds: string[] = [LOC],
) =>
  ({
    membershipId,
    user: { id: userId, name, email: `${name.toLowerCase()}@example.com` },
    role,
    locationIds,
  }) as MemberList[number];

const invitation = (
  id: string,
  email: string,
  staffMemberId: string | null,
  status: 'pending' | 'revoked' = 'pending',
  role: 'manager' | 'staff' = 'staff',
) =>
  ({
    id,
    email,
    phone: null,
    role,
    staffMemberId,
    status,
    locationIds: [LOC],
  }) as InvitationList[number];

describe('teamOf', () => {
  it('specialists by the salon order: with an account, invited, without an account', () => {
    const team = teamOf(
      [
        staff('s-kasia', 'Kasia', null, 2),
        staff('s-marek', 'Marek', 'u-marek', 1),
        staff('s-tomek', 'Tomek', null, 3),
        staff('s-old', 'Old', null, 0, false),
      ],
      [
        member('m-owner', 'u-owner', 'Ola', 'owner', []),
        member('m-marek', 'u-marek', 'Marek', 'staff'),
      ],
      [
        invitation('i-kasia', 'kasia@example.com', 's-kasia'),
        invitation('i-gone', 'tomek@example.com', 's-tomek', 'revoked'),
        invitation('i-ania', 'ania@example.com', null, 'pending', 'manager'),
      ],
      LOC,
    );
    expect(team.specialists.map((r) => [r.staff.displayName, r.state])).toEqual([
      ['Marek', 'account'],
      ['Kasia', 'invited'],
      ['Tomek', 'none'],
    ]);
    const marek = team.specialists[0]!;
    expect(marek.state === 'account' && marek.member?.membershipId).toBe('m-marek');
    // Marek is shown with his profile; the owner (no locations: all of them) is listed here.
    expect(team.managers.map((m) => m.user.name)).toEqual(['Ola']);
    // Kasia's invitation sits on her profile; the revoked one is gone.
    expect(team.invitations.map((i) => i.id)).toEqual(['i-ania']);
  });

  it("leaves out managers and invitations of the organization's other salons", () => {
    const team = teamOf(
      [],
      [
        member('m-1', 'u-1', 'Basia', 'manager', ['loc-2']),
        member('m-2', 'u-2', 'Adam', 'manager'),
        member('m-0', 'u-0', 'Zofia', 'owner'),
      ],
      [{ ...invitation('i-1', 'x@example.com', null), locationIds: ['loc-2'] }],
      LOC,
    );
    expect(team.managers.map((m) => m.user.name)).toEqual(['Zofia', 'Adam']);
    expect(team.invitations).toEqual([]);
  });
});

describe('rights', () => {
  it('the owner invites managers and specialists, a manager only specialists', () => {
    expect(rolesToInvite('owner')).toEqual(['staff', 'manager']);
    expect(rolesToInvite('manager')).toEqual(['staff']);
    expect(rolesToInvite('staff')).toEqual([]);
  });

  it('only the owner removes people, never another owner', () => {
    expect(mayRemove('owner', member('m', 'u', 'A', 'manager'))).toBe(true);
    expect(mayRemove('owner', member('m', 'u', 'A', 'owner'))).toBe(false);
    expect(mayRemove('manager', member('m', 'u', 'A', 'staff'))).toBe(false);
  });
});

describe('inviteBody', () => {
  const options = {
    role: 'staff' as const,
    locationId: LOC,
    staffMemberId: 's-kasia',
    dial: '48',
    locale: 'pl' as const,
  };

  it('email in small letters, phone with the salon code, the profile to take over', () => {
    expect(inviteBody({ email: ' Kasia@Example.com ', phone: '600 100 200' }, options)).toEqual({
      ok: true,
      body: {
        email: 'kasia@example.com',
        phone: '+48600100200',
        role: 'staff',
        locationIds: [LOC],
        staffMemberId: 's-kasia',
        locale: 'pl',
      },
    });
  });

  it('the phone is optional; a manager is never tied to a specialist profile', () => {
    const result = inviteBody(
      { email: 'ania@example.com', phone: '' },
      { ...options, role: 'manager' },
    );
    expect(result).toEqual({
      ok: true,
      body: { email: 'ania@example.com', role: 'manager', locationIds: [LOC], locale: 'pl' },
    });
  });

  it('says what is wrong', () => {
    expect(inviteBody({ email: 'kasia@', phone: '' }, options)).toEqual({
      ok: false,
      problem: 'email',
    });
    expect(inviteBody({ email: 'kasia@example.com', phone: '12' }, options)).toEqual({
      ok: false,
      problem: 'phone',
    });
  });
});

describe('inviteError', () => {
  it('names the conflicts the owner can fix', () => {
    expect(inviteError(new ApiError(409, 'x', 'ALREADY_MEMBER'))).toBe('alreadyMember');
    expect(inviteError(new ApiError(409, 'x', 'STAFF_ALREADY_LINKED'))).toBe('linked');
    expect(inviteError(new ApiError(403, 'x', 'FORBIDDEN'))).toBe('forbidden');
    expect(inviteError(new ApiError(500, 'x'))).toBe('other');
    expect(inviteError(new Error('offline'))).toBe('other');
  });
});
