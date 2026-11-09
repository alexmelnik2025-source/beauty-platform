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
 * Task 350: "Załóż salon" in the business app (web preview of apps/mobile-business). A person who
 * registered on the website but has no salon signs in to the app, picks Czechia (the currency
 * follows), goes back to Poland, gets a wrong postal code pointed out and creates the company and
 * its salon; the app opens the new salon's day. Screenshots 350, 350a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-new-salon-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544).
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.19.${n >> 8}.${n & 255}` };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: ADDRESS,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app: a person without a salon sets one up', async ({ browser, request }) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: ADDRESS,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();

    await expect(phone.getByText('Masz własny salon?')).toBeVisible();
    await shot(phone, '350-business-app-no-salon');
    await phone.getByRole('button', { name: 'Załóż salon' }).click();
    await expect(phone.getByLabel('Kraj i strefa czasowa: Polska (Warsaw)')).toBeVisible();
    await expect(phone.getByLabel(/^Waluta cen: PLN/)).toBeVisible();

    // Another country brings its currency, until the person picks one.
    await phone.getByRole('button', { name: 'Zmień: Kraj i strefa czasowa' }).click();
    await phone.getByLabel('Szukaj: Kraj i strefa czasowa').fill('czech');
    await phone.getByRole('radio', { name: 'Czechy (Prague)' }).click();
    await expect(phone.getByLabel(/^Waluta cen: CZK/)).toBeVisible();
    await phone.getByRole('button', { name: 'Zmień: Kraj i strefa czasowa' }).click();
    await phone.getByLabel('Szukaj: Kraj i strefa czasowa').fill('polska');
    await phone.getByRole('radio', { name: 'Polska (Warsaw)' }).click();
    await expect(phone.getByLabel(/^Waluta cen: PLN/)).toBeVisible();

    await phone.getByLabel('Nazwa firmy').fill('GESTALT');
    await phone.getByLabel('Nazwa salonu').fill('Gestalt Barbershop');
    await phone.getByLabel('Ulica i numer').fill('ul. Józefa Bema 91');
    await phone.getByLabel('Miasto').fill('Warszawa');
    await phone.getByLabel('Kod pocztowy').fill('1233');
    await phone.getByRole('button', { name: 'Załóż salon' }).click();
    await expect(phone.getByText('Wpisz kod pocztowy, np. 01-233.')).toBeVisible();
    await phone.getByLabel('Kod pocztowy').fill('01233');
    await phone.getByLabel('Nazwa firmy').scrollIntoViewIfNeeded();
    await shot(phone, '350a-business-app-new-salon');
    await phone.getByRole('button', { name: 'Załóż salon' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const me = await json<{ organizations: { id: string; name: string; role: string }[] }>(
    await request.get('/v1/me', { headers: owner }),
  );
  expect(me.organizations).toEqual([expect.objectContaining({ name: 'GESTALT', role: 'owner' })]);
  const locations = await json<Record<string, unknown>[]>(
    await request.get(`/v1/organizations/${me.organizations[0]!.id}/locations`, {
      headers: owner,
    }),
  );
  expect(locations).toEqual([
    expect.objectContaining({
      name: 'Gestalt Barbershop',
      addressLine: 'ul. Józefa Bema 91',
      city: 'Warszawa',
      postalCode: '01-233',
      timezone: 'Europe/Warsaw',
      currency: 'PLN',
      onlineBookingEnabled: false,
    }),
  ]);
});
