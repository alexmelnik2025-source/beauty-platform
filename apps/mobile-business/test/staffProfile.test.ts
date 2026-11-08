import { describe, expect, it } from 'vitest';
import { BusinessApi, type ServiceList, type StaffList, type TokenStore } from '../src/api';
import {
  movedOrder,
  nextSortOrder,
  profileChanges,
  profileForm,
  serviceChoices,
  teamForProfiles,
  toggleSpecialty,
} from '../src/staffProfile';

type Staff = StaffList[number];

const kasia: Staff = {
  id: 'k',
  locationId: 'l1',
  userId: null,
  displayName: 'Kasia',
  bio: null,
  languages: ['pl'],
  specialties: ['barber'],
  customSpecialty: null,
  active: true,
  sortOrder: 0,
  version: 3,
  serviceIds: ['s1', 's2'],
  photoUrl: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
};

describe('a specialist’s profile (tasks 326–327)', () => {
  it('starts from what the server has; nothing changed = nothing to send', () => {
    const form = profileForm(kasia);
    expect(form).toEqual({
      displayName: 'Kasia',
      bio: '',
      specialties: ['barber'],
      customSpecialty: '',
      active: true,
      serviceIds: ['s1', 's2'],
    });
    expect(profileChanges(kasia, form)).toEqual({ change: null, serviceIds: null });
    // The same services in another order are the same services.
    expect(profileChanges(kasia, { ...form, serviceIds: ['s2', 's1'] })).toEqual({
      change: null,
      serviceIds: null,
    });
  });

  it('sends only what changed, trimmed; empty texts clear them', () => {
    const withBio = { ...kasia, bio: 'Fade', customSpecialty: 'Trycholog' };
    const result = profileChanges(withBio, {
      ...profileForm(withBio),
      displayName: '  Kasia Nowak ',
      bio: '  ',
      specialties: ['barber', 'hairdresser'],
      customSpecialty: '',
      active: false,
      serviceIds: ['s1'],
    });
    expect(result).toEqual({
      change: {
        displayName: 'Kasia Nowak',
        bio: null,
        specialties: ['barber', 'hairdresser'],
        customSpecialty: null,
        active: false,
      },
      serviceIds: ['s1'],
    });
  });

  it('the order of specialties counts (the first is the main one)', () => {
    const two = { ...kasia, specialties: ['barber', 'hairdresser'] as Staff['specialties'] };
    expect(
      profileChanges(two, { ...profileForm(two), specialties: ['hairdresser', 'barber'] }),
    ).toEqual({ change: { specialties: ['hairdresser', 'barber'] }, serviceIds: null });
  });

  it('a name is needed', () => {
    expect(profileChanges(kasia, { ...profileForm(kasia), displayName: '  ' })).toEqual({
      problem: 'noName',
    });
  });

  it('toggles a specialty, adding it at the end', () => {
    expect(toggleSpecialty(['barber'], 'massage')).toEqual(['barber', 'massage']);
    expect(toggleSpecialty(['barber', 'massage'], 'barber')).toEqual(['massage']);
  });

  it('offers the offered services and a hidden one the person still does', () => {
    const services = [
      { id: 's1', active: true },
      { id: 's2', active: false },
      { id: 's3', active: false },
    ] as ServiceList;
    expect(serviceChoices(services, ['s2']).map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('the team list (tasks 326, 328, 329)', () => {
  const team = [
    { ...kasia, id: 'b', displayName: 'Bartek', sortOrder: 10, active: false },
    { ...kasia, id: 'k', displayName: 'Kasia', sortOrder: 20 },
    { ...kasia, id: 'a', displayName: 'Ania', sortOrder: 20 },
    { ...kasia, id: 'i', displayName: 'Ilian', sortOrder: 0 },
  ];

  it('those taking clients first, then the switched-off ones; each in the salon’s order', () => {
    expect(teamForProfiles(team).map((s) => s.id)).toEqual(['i', 'a', 'k', 'b']);
  });

  it('moves one up or down; nothing past the ends', () => {
    const shown = teamForProfiles(team);
    expect(movedOrder(shown, 'a', -1)).toEqual(['a', 'i', 'k', 'b']);
    expect(movedOrder(shown, 'k', 1)).toEqual(['i', 'a', 'b', 'k']);
    expect(movedOrder(shown, 'i', -1)).toBeNull();
    expect(movedOrder(shown, 'b', 1)).toBeNull();
    expect(movedOrder(shown, 'x', 1)).toBeNull();
  });

  it('a new specialist goes after everyone', () => {
    expect(nextSortOrder(team)).toBe(30);
    expect(nextSortOrder([])).toBe(0);
  });
});

describe('BusinessApi: specialists', () => {
  const store: TokenStore = {
    async get() {
      return 'refresh-token-0123456789';
    },
    async set() {},
  };

  function server() {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (key === 'POST /v1/auth/refresh') {
        return new Response(
          JSON.stringify({
            accessToken: 'a1',
            expiresIn: 900,
            refreshToken: 'refresh-token-0123456789new',
          }),
          { status: 200 },
        );
      }
      if (key.endsWith('/staff/order')) return new Response(JSON.stringify([kasia]));
      return new Response(JSON.stringify(kasia), { status: key.startsWith('POST') ? 201 : 200 });
    };
    return { api: new BusinessApi('https://api.test', store, fetchFn), calls };
  }

  it('changes the profile with the version, the services, adds one and sets the order', async () => {
    const { api, calls } = server();
    const base = '/v1/organizations/o1/locations/l1/staff';
    await api.updateStaff('o1', 'l1', 'k', 3, { displayName: 'Kasia Nowak', active: false });
    await api.setStaffServices('o1', 'l1', 'k', ['s1']);
    await api.createStaff('o1', 'l1', { displayName: 'Marek', sortOrder: 30, serviceIds: ['s1'] });
    await api.reorderStaff('o1', 'l1', ['k', 'i']);
    expect(calls.filter((c) => !c.key.includes('/auth/'))).toEqual([
      {
        key: `PATCH ${base}/k`,
        body: { displayName: 'Kasia Nowak', active: false, version: 3 },
      },
      { key: `PUT ${base}/k/services`, body: { serviceIds: ['s1'] } },
      { key: `POST ${base}`, body: { displayName: 'Marek', sortOrder: 30, serviceIds: ['s1'] } },
      { key: `PUT ${base}/order`, body: { staffIds: ['k', 'i'] } },
    ]);
  });
});
