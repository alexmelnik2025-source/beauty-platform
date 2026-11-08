import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 334: "Dane osobowe (RODO)" in the client card of the business app (web preview of
 * apps/mobile-business). The owner downloads the client's data as a JSON file and then erases
 * them: the name becomes "—", contacts are gone, the visits would stay. Screenshots 334, 334a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-client-privacy-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '203.0.113.88' };

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

type Client = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  anonymizedAt: string | null;
};

test('business app: the owner downloads and erases a client’s data (GDPR)', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  await json(
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
  const jan = await json<Client>(
    await request.post(`/v1/organizations/${org.id}/customers`, {
      headers: owner,
      data: { name: 'Jan Nowak', phone: '+48600500600', email: 'jan.nowak@example.com' },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      acceptDownloads: true,
      extraHTTPHeaders: OWNER_IP,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await phone.getByRole('button', { name: 'Klienci' }).click();
    await phone.getByRole('button', { name: 'Karta klienta: Jan Nowak', exact: true }).click();
    await expect(phone.getByRole('heading', { name: 'Jan Nowak' })).toBeVisible();
    await expect(phone.getByText('Dane osobowe (RODO)')).toBeVisible();

    // ── download: the JSON file with everything the salon keeps ────────────
    const [download] = await Promise.all([
      phone.waitForEvent('download'),
      phone.getByRole('button', { name: 'Pobierz dane klienta' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`client-${jan.id}.json`);
    const file = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
      salon: { name: string };
      client: { name: string; phone: string; email: string };
    };
    expect(file.salon.name).toBe('GESTALT');
    expect(file.client).toMatchObject({
      name: 'Jan Nowak',
      phone: '+48600500600',
      email: 'jan.nowak@example.com',
    });
    await expect(phone.getByText('Plik z danymi klienta gotowy.')).toBeVisible();

    // ── erase: asks first, then the card has no personal data ─────────────
    await phone.getByRole('button', { name: 'Usuń dane klienta' }).click();
    await expect(phone.getByText(/zostaną usunięte na zawsze/)).toBeVisible();
    await phone.getByText('Dane osobowe (RODO)').scrollIntoViewIfNeeded();
    await shot(phone, '334-business-app-client-erase');
    await phone.getByRole('button', { name: 'Tak, usuń dane' }).click();
    await expect(
      phone.getByText('Dane klienta usunięte. Wizyty zostały w statystyce: 0.'),
    ).toBeVisible();
    await expect(phone.getByText(/Dane klienta usunięte \(RODO\)/)).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Pobierz dane klienta' })).toHaveCount(0);
    await expect(phone.getByRole('button', { name: /600500600/ })).toHaveCount(0);
    await shot(phone, '334a-business-app-client-erased');
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const erased = await json<Client>(
    await request.get(`/v1/organizations/${org.id}/customers/${jan.id}`, { headers: owner }),
  );
  expect(erased.name).toBe('—');
  expect(erased.email).toBeNull();
  expect(erased.anonymizedAt).toBeTruthy();
});
