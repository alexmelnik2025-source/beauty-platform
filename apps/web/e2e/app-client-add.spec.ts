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
 * Tasks 332–333: client cards from the business app (web preview of apps/mobile-business).
 * The owner adds a client in "Klienci" — the phone of an existing client is pointed out (open
 * their card or add anyway) — and then changes the new client's phone, email and language in
 * the card. Screenshots 332, 332a, 333.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-client-add-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '203.0.113.87' };

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

type Client = { id: string; name: string; phone: string; email: string | null; locale: string };

test('business app: the owner adds a client and changes their details', async ({
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
      data: { name: 'Jan Kowalski', phone: '+48600100200' },
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
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    // ── 332: a new client; Jan's phone is pointed out ──────────────────────
    await phone.getByRole('button', { name: 'Klienci' }).click();
    await phone.getByRole('button', { name: '+ Dodaj klienta' }).click();
    await phone.getByRole('button', { name: 'Zapisz klienta' }).click();
    await expect(phone.getByText('Wpisz imię klienta.')).toBeVisible();
    await phone.getByLabel('Imię i nazwisko').fill('Olena Shevchenko');
    await phone.getByLabel('Telefon', { exact: true }).fill('600 100 200');
    await phone.getByRole('button', { name: 'Українська' }).click();
    await phone.getByRole('button', { name: 'Zapisz klienta' }).click();
    await expect(
      phone.getByText('Klient z tym numerem telefonu już jest w salonie.'),
    ).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Otwórz jego kartę' })).toBeVisible();
    await shot(phone, '332a-business-app-client-exists');
    await phone.getByLabel('Telefon', { exact: true }).fill('600 300 400');
    await phone.getByLabel('E-mail (opcjonalnie)').fill('Olena@Example.com');
    await phone.getByRole('button', { name: 'Zapisz klienta' }).click();
    await expect(phone.getByRole('heading', { name: 'Olena Shevchenko' })).toBeVisible();
    await expect(phone.getByText('Klient dodany.')).toBeVisible();
    await shot(phone, '332-business-app-client-added');

    // ── 333: the new phone, no email, English ──────────────────────────────
    await phone.getByRole('button', { name: '✎ Zmień dane' }).click();
    await expect(phone.getByLabel('Telefon', { exact: true })).toHaveValue('+48600300400');
    await phone.getByLabel('Telefon', { exact: true }).fill('+48 600 300 401');
    await phone.getByLabel('E-mail (opcjonalnie)').fill('');
    await phone.getByRole('button', { name: 'English' }).click();
    await shot(phone, '333-business-app-client-details');
    await phone.getByRole('button', { name: 'Zapisz dane' }).click();
    await expect(phone.getByText('Dane klienta zapisane.')).toBeVisible();
    await expect(phone.getByRole('button', { name: /600300401/ })).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const list = await json<{ items: Client[] } | Client[]>(
    await request.get(`/v1/organizations/${org.id}/customers?search=Olena`, { headers: owner }),
  );
  const items = Array.isArray(list) ? list : list.items;
  expect(items).toHaveLength(1);
  const olena = await json<Client>(
    await request.get(`/v1/organizations/${org.id}/customers/${items[0]!.id}`, {
      headers: owner,
    }),
  );
  expect(olena).toMatchObject({
    name: 'Olena Shevchenko',
    phone: '+48600300401',
    email: null,
    locale: 'en',
  });
  // Jan was not touched.
  const janNow = await json<Client>(
    await request.get(`/v1/organizations/${org.id}/customers/${jan.id}`, { headers: owner }),
  );
  expect(janNow.phone).toBe('+48600100200');
});
