import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { waitForEmail } from './mailpit';

export type Role = 'owner' | 'manager' | 'staff';

async function post(api: APIRequestContext, path: string, data: object, access?: string) {
  const response = await api.post(path, {
    data,
    headers: access ? { Authorization: 'Bearer ' + access } : undefined,
  });
  await expect(response).toBeOK();
  return response;
}

export async function createRoleSalon(api: APIRequestContext) {
  const suffix = randomUUID();
  const password = randomUUID();
  const accounts = {} as Record<Role, { email: string; password: string }>;
  for (const role of ['owner', 'manager', 'staff'] as const) {
    const email = `ej-${role}-${suffix}@test.pl`;
    accounts[role] = { email, password };
    await post(api, '/v1/auth/register', { email, password, name: 'EJ ' + role });
    const mail = await waitForEmail(email, /Potwierdź adres/);
    const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();
    await post(api, '/v1/auth/verify-email', { token: decodeURIComponent(token!) });
  }
  async function login(role: Role): Promise<{ accessToken: string; refreshToken: string }> {
    return (await post(api, '/v1/auth/login', { ...accounts[role], clientType: 'mobile' })).json();
  }
  const owner = (await login('owner')).accessToken;
  const org = await (await post(api, '/v1/organizations', { name: 'Studio EJ' }, owner)).json();
  const base = '/v1/organizations/' + org.id;
  const salon = await (
    await post(
      api,
      base + '/locations',
      {
        name: 'Studio EJ',
        city: 'Warszawa',
        addressLine: 'Testowa 1',
        postalCode: '00-001',
      },
      owner,
    )
  ).json();
  const location = base + '/locations/' + salon.id;
  const employee = await (
    await post(api, location + '/staff', { displayName: 'EJ Staff' }, owner)
  ).json();
  for (const role of ['manager', 'staff'] as const) {
    await post(
      api,
      base + '/invitations',
      {
        role,
        email: accounts[role].email,
        locationIds: [salon.id],
        ...(role === 'staff' ? { staffMemberId: employee.id } : {}),
      },
      owner,
    );
    const mail = await waitForEmail(accounts[role].email, /Zaproszenie/);
    const token = /\/invite\/(\S+)/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();
    await post(api, '/v1/invitations/' + token + '/accept', {}, (await login(role)).accessToken);
  }
  return { login, base };
}
