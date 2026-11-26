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
        name: 'Studio EJ ' + suffix,
        city: 'Warszawa',
        addressLine: 'Testowa 1',
        postalCode: '00-001',
      },
      owner,
    )
  ).json();
  const location = base + '/locations/' + salon.id;
  const service = await (
    await post(
      api,
      location + '/services',
      {
        name: 'EJ Cut',
        durationMinutes: 30,
        priceGrosze: 8000,
      },
      owner,
    )
  ).json();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const tomorrow = new Date(today + 'T12:00:00Z');
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);
  async function book(staffName: string, customerName: string, phone: string) {
    const employee = await (
      await post(
        api,
        location + '/staff',
        {
          displayName: staffName,
          serviceIds: [service.id],
        },
        owner,
      )
    ).json();
    await expect(
      await api.put(location + '/staff/' + employee.id + '/working-hours', {
        headers: { Authorization: 'Bearer ' + owner },
        data: {
          days: [
            { weekday: tomorrow.getUTCDay() || 7, intervals: [{ start: '09:00', end: '17:00' }] },
          ],
        },
      }),
    ).toBeOK();
    await post(
      api,
      location + '/appointments',
      {
        staffId: employee.id,
        serviceId: service.id,
        start: date + 'T10:00:00Z',
        customer: { name: customerName, phone },
      },
      owner,
    );
    return employee.id as string;
  }
  const employeeId = await book('EJ Staff', 'EJ Own Client', '+48500600931');
  await book('EJ Colleague', 'EJ Other Client', '+48500600932');
  for (const role of ['manager', 'staff'] as const) {
    await post(
      api,
      base + '/invitations',
      {
        role,
        email: accounts[role].email,
        locationIds: [salon.id],
        ...(role === 'staff' ? { staffMemberId: employeeId } : {}),
      },
      owner,
    );
    const mail = await waitForEmail(accounts[role].email, /Zaproszenie/);
    const token = /\/invite\/(\S+)/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();
    await post(api, '/v1/invitations/' + token + '/accept', {}, (await login(role)).accessToken);
  }
  return { login, base, today };
}
