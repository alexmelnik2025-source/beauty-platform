import { describe, expect, it } from 'vitest';
import {
  ApiError,
  BusinessApi,
  type MemberList,
  type PermissionCatalog,
  type StaffCategoryList,
  type TokenStore,
} from '../src/api';
import {
  categoryBody,
  categoryForm,
  changedMeanwhile,
  effective,
  exceptionOf,
  memberUnchanged,
  specialistsWithAccess,
  withException,
} from '../src/rights';

const catalog: PermissionCatalog['permissions'] = [
  { key: 'createOwnAppointments', default: true },
  { key: 'viewClientContacts', default: false },
  { key: 'viewOwnEarnings', default: false },
];

const senior = {
  id: 'c1',
  name: 'Starszy barber',
  permissions: { viewClientContacts: true },
  memberCount: 1,
  version: 2,
} as StaffCategoryList[number];

const member = (over: Partial<MemberList[number]>): MemberList[number] =>
  ({
    membershipId: 'm1',
    user: { id: 'u1', name: 'Kasia', email: 'kasia@example.com' },
    role: 'staff',
    status: 'active',
    locationIds: ['l1'],
    staffCategoryId: null,
    overrides: {},
    permissions: {},
    version: 1,
    ...over,
  }) as MemberList[number];

describe('categories of rights (task 331)', () => {
  it('a new one starts from the defaults; an existing one from its values', () => {
    expect(categoryForm(null, catalog)).toEqual({
      name: '',
      permissions: {
        createOwnAppointments: true,
        viewClientContacts: false,
        viewOwnEarnings: false,
      },
    });
    expect(categoryForm(senior, catalog).permissions).toEqual({
      createOwnAppointments: true,
      viewClientContacts: true,
      viewOwnEarnings: false,
    });
  });

  it('needs a name; sends every tick', () => {
    expect(categoryBody({ ...categoryForm(null, catalog), name: '  ' })).toEqual({ ok: false });
    expect(categoryBody({ ...categoryForm(senior, catalog), name: ' Senior ' })).toEqual({
      ok: true,
      name: 'Senior',
      permissions: {
        createOwnAppointments: true,
        viewClientContacts: true,
        viewOwnEarnings: false,
      },
    });
  });
});

describe('a specialist’s rights (task 330)', () => {
  it('reads and sets one exception', () => {
    expect(exceptionOf({}, 'viewOwnEarnings')).toBe('category');
    expect(exceptionOf({ viewOwnEarnings: true }, 'viewOwnEarnings')).toBe('yes');
    expect(exceptionOf({ viewOwnEarnings: false }, 'viewOwnEarnings')).toBe('no');
    expect(withException({}, 'viewOwnEarnings', 'yes')).toEqual({ viewOwnEarnings: true });
    expect(withException({ viewOwnEarnings: true }, 'viewOwnEarnings', 'no')).toEqual({
      viewOwnEarnings: false,
    });
    expect(withException({ viewOwnEarnings: true }, 'viewOwnEarnings', 'category')).toEqual({});
  });

  it('exception, else the category, else the default', () => {
    expect(effective(catalog, senior, { createOwnAppointments: false })).toEqual({
      createOwnAppointments: false,
      viewClientContacts: true,
      viewOwnEarnings: false,
    });
    expect(effective(catalog, null, {})).toEqual({
      createOwnAppointments: true,
      viewClientContacts: false,
      viewOwnEarnings: false,
    });
  });

  it('lists active specialists of this salon with an account, by name', () => {
    const list = [
      member({ membershipId: 'z', user: { id: 'u2', name: 'Zenek', email: 'z@x.pl' } }),
      member({ membershipId: 'a', user: { id: 'u3', name: 'Ania', email: 'a@x.pl' } }),
      member({ membershipId: 'o', role: 'owner' }),
      member({ membershipId: 'm', role: 'manager' }),
      member({ membershipId: 'i', status: 'invited' }),
      member({ membershipId: 'x', locationIds: ['l2'] }),
    ];
    expect(specialistsWithAccess(list, 'l1').map((m) => m.membershipId)).toEqual(['a', 'z']);
  });

  it('knows when nothing changed', () => {
    const kasia = member({ staffCategoryId: 'c1', overrides: { viewOwnEarnings: true } });
    expect(memberUnchanged(kasia, 'c1', { viewOwnEarnings: true })).toBe(true);
    expect(memberUnchanged(kasia, null, { viewOwnEarnings: true })).toBe(false);
    expect(memberUnchanged(kasia, 'c1', {})).toBe(false);
    expect(memberUnchanged(kasia, 'c1', { viewOwnEarnings: false })).toBe(false);
  });

  it('recognises a save that came too late', () => {
    expect(changedMeanwhile(new ApiError(409, 'x', 'VERSION_CONFLICT'))).toBe(true);
    expect(changedMeanwhile(new ApiError(403, 'x', 'FORBIDDEN'))).toBe(false);
    expect(changedMeanwhile(new Error('x'))).toBe(false);
  });
});

describe('BusinessApi: rights', () => {
  it('reads, creates, changes and deletes categories; sets a person’s rights', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (key.startsWith('POST /v1/auth/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: 'a9',
            expiresIn: 900,
            refreshToken: 'refresh-token-0123456789new',
          }),
        );
      }
      if (key.startsWith('DELETE')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(key.startsWith('GET') ? [] : {}));
    };
    const store: TokenStore = {
      get: async () => 'refresh-token-0123456789abc',
      set: async () => undefined,
    };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.staffCategories('o1');
    await api.createStaffCategory('o1', { name: 'Senior', permissions: { viewOwnEarnings: true } });
    await api.updateStaffCategory('o1', 'c1', 2, { name: 'Starszy' });
    await api.deleteStaffCategory('o1', 'c1');
    await api.setMemberPermissions('o1', 'm1', {
      version: 4,
      staffCategoryId: 'c1',
      overrides: { viewClientContacts: false },
    });
    const org = '/v1/organizations/o1';
    expect(calls.slice(1)).toEqual([
      { key: `GET ${org}/staff-categories`, body: undefined },
      {
        key: `POST ${org}/staff-categories`,
        body: { name: 'Senior', permissions: { viewOwnEarnings: true } },
      },
      { key: `PATCH ${org}/staff-categories/c1`, body: { name: 'Starszy', version: 2 } },
      { key: `DELETE ${org}/staff-categories/c1`, body: undefined },
      {
        key: `PUT ${org}/members/m1/permissions`,
        body: { version: 4, staffCategoryId: 'c1', overrides: { viewClientContacts: false } },
      },
    ]);
  });
});
