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
 * Task 345: "Poziomy klientów" in "Program lojalnościowy" of the business app (web preview of
 * apps/mobile-business). The owner adds Silver (5 visits, −5%) and Gold (10 visits, −10%); the
 * same threshold twice is pointed out. Screenshot 345.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-loyalty-tiers-owner-${run}@example.com`;
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

test('business app: the owner sets customer tiers', async ({ browser, request }) => {
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
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await phone.getByRole('button', { name: 'Program lojalnościowy' }).click();
    await expect(phone.getByText('Brak poziomów — klienci nie mają statusu.')).toBeVisible();
    await phone.getByRole('button', { name: 'Zmień poziomy' }).click();
    await phone.getByRole('button', { name: '+ Dodaj poziom' }).click();
    await phone.getByRole('button', { name: '+ Dodaj poziom' }).click();
    await phone.getByLabel('Nazwa poziomu 1').fill('Silver');
    await phone.getByLabel('Od ilu wizyt (poziom 1)').fill('5');
    await phone.getByLabel('Rabat % (poziom 1)').fill('5');
    await phone.getByLabel('Nazwa poziomu 2').fill('Gold');
    await phone.getByLabel('Od ilu wizyt (poziom 2)').fill('5');
    await phone.getByLabel('Rabat % (poziom 2)').fill('10');
    await phone.getByRole('button', { name: 'Zapisz poziomy' }).click();
    await expect(
      phone.getByText('Poziom 2: dwa poziomy nie mogą mieć tego samego progu.'),
    ).toBeVisible();
    await phone.getByLabel('Od ilu wizyt (poziom 2)').fill('10');
    await shot(phone, '345-business-app-loyalty-tiers');
    await phone.getByRole('button', { name: 'Zapisz poziomy' }).click();
    await expect(phone.getByText('Poziomy zapisane.')).toBeVisible();
    await expect(phone.getByText('Silver · od 5 wizyt · −5%')).toBeVisible();
    await expect(phone.getByText('Gold · od 10 wizyt · −10%')).toBeVisible();
    await expect(phone.getByText('Liczone z ostatnich 365 dni.')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<{
    basis: string;
    tiers: { name: string; threshold: number; discountPercent: number }[];
  }>(await request.get(`/v1/organizations/${org.id}/loyalty/tiers`, { headers: owner }));
  expect(saved.basis).toBe('visits');
  expect(saved.tiers.map((t) => [t.name, t.threshold, t.discountPercent])).toEqual([
    ['Silver', 5, 5],
    ['Gold', 10, 10],
  ]);
});
