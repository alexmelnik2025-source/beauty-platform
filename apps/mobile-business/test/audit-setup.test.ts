import { describe, expect, it } from 'vitest';
import type { Invitation, MemberList, StaffList } from '../src/api';
import { mayRemove, teamOf } from '../src/team';

const location = 'salon';
const profile = (id: string, userId: string | null): StaffList[number] => ({
  id,
  userId,
  displayName: id,
  locationId: location,
  active: false,
  sortOrder: 0,
  bio: null,
  languages: [],
  specialties: [],
  customSpecialty: null,
  version: 1,
  serviceIds: [],
  photoUrl: null,
  createdAt: '',
  updatedAt: '',
});

describe('team access when a specialist stops taking bookings', () => {
  it('keeps the account visible to the owner who can revoke its access', () => {
    const member = {
      membershipId: 'membership',
      user: { id: 'user', name: 'Alex', email: 'alex@example.test' },
      role: 'staff',
      status: 'active',
      locationIds: [location],
    } as MemberList[number];
    const specialist = profile('alex', 'user');
    const team = teamOf([specialist, profile('old', null)], [member], [], location);
    expect(team.specialists).toEqual([{ staff: specialist, state: 'account', member }]);
    expect(team.managers).toEqual([]);
    expect(mayRemove('owner', member)).toBe(true);
    const otherSalonMember = { ...member, locationIds: ['other'] };
    expect(teamOf([specialist], [otherSalonMember], [], location).specialists).toEqual([]);
  });

  it('keeps a pending invitation available to cancel, without restoring an expired one', () => {
    const invited = profile('invited', null);
    const invitation: Invitation = {
      id: 'invitation',
      email: 'invited@example.test',
      phone: null,
      staffMemberId: invited.id,
      role: 'staff',
      locationIds: [location],
      staffCategoryId: null,
      status: 'pending',
      createdAt: '',
      expiresAt: '',
    };
    const expired = {
      ...invitation,
      id: 'expired',
      staffMemberId: 'former',
      status: 'expired',
    } as const;
    const team = teamOf([invited, profile('former', null)], [], [invitation, expired], location);
    expect(team.specialists).toEqual([{ staff: invited, state: 'invited', invitation }]);
    expect(team.invitations).toEqual([]);
    const otherSalonInvite = { ...invitation, locationIds: ['other'] };
    expect(teamOf([invited], [], [otherSalonInvite], location).specialists).toEqual([]);
  });
});
