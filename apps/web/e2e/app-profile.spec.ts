import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 96: "Mój profil" in the business app (web preview of apps/mobile-business). A specialist
 * invited by the owner signs in with a code and chooses the languages she speaks with clients;
 * the booking page then shows them. Screenshots go to e2e/screenshots (91–91a).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-profile-owner-${run}@example.com`;
const KASIA = `app-profile-kasia-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '198.51.100.97' };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: OWNER_IP,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app: a specialist chooses the languages she speaks with clients', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const kasia = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia Nowak', languages: ['pl'] },
    }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/invitations`, {
      headers: owner,
      data: { email: KASIA, role: 'staff', locationIds: [location.id], staffMemberId: kasia.id },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: OWNER_IP,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    // The invited specialist signs in with a code: no password, no sign-up.
    await phone.getByLabel('E-mail lub telefon').fill(KASIA);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(KASIA, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await phone.getByRole('button', { name: 'Mój profil' }).click();
    await expect(phone.getByRole('heading', { name: 'Mój profil' })).toBeVisible();
    await expect(phone.getByText('Kasia Nowak')).toBeVisible();
    const polish = phone.getByRole('checkbox', { name: 'Polski' });
    await expect(polish).toBeChecked();
    const save = phone.getByRole('button', { name: 'Zapisz języki' });
    await expect(save).toBeDisabled();
    await phone.getByRole('checkbox', { name: 'English' }).click();
    await phone.getByRole('checkbox', { name: 'Українська' }).click();
    await shot(phone, '91-business-app-profile-languages');
    await save.click();
    await expect(phone.getByText('Języki zapisane.', { exact: false })).toBeVisible();
    await expect(phone.getByText('Gestalt Barbershop · 🇵🇱 🇺🇦 🇬🇧')).toBeVisible();
    await shot(phone, '91a-business-app-profile-saved');
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const staff = await json<{ id: string; languages: string[] }[]>(
    await request.get(`${base}/staff`, { headers: owner }),
  );
  expect(staff.find((s) => s.id === kasia.id)?.languages).toEqual(['pl', 'uk', 'en']);
});
