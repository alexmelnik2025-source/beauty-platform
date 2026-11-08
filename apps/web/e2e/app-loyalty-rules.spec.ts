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
 * Task 344: "Zasady programu" in "Program lojalnościowy" of the business app (web preview of
 * apps/mobile-business). The owner switches the stamp card to points (5 for every 10 zł, valid
 * 180 days, at most 30% off); a wrong amount is pointed out. Screenshots 344, 344a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-loyalty-rules-owner-${run}@example.com`;
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

test('business app: the owner changes the loyalty program’s rules', async ({
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
    await expect(phone.getByText('Zasady programu')).toBeVisible();
    await phone.getByRole('button', { name: 'Zmień zasady' }).click();
    await phone.getByRole('button', { name: 'Punkty za kwotę' }).click();
    await phone.getByLabel('Ile punktów').fill('5');
    await phone.getByLabel(/^Za każde/).fill('0');
    await phone.getByLabel(/^Punkty ważne/).fill('180');
    await phone.getByLabel('Maksymalna zniżka na wizytę (%)').fill('30');
    await phone.getByRole('button', { name: 'Zapisz zasady' }).click();
    await expect(phone.getByText('Wpisz kwotę, np. 50 lub 50,50.')).toBeVisible();
    await phone.getByLabel(/^Za każde/).fill('10');
    await shot(phone, '344-business-app-loyalty-rules');
    await phone.getByRole('button', { name: 'Zapisz zasady' }).click();
    await expect(phone.getByText('Zasady programu zapisane.')).toBeVisible();
    await expect(phone.getByText(/punkty ważne 180 dni · maks\. zniżka 30%/)).toBeVisible();
    await shot(phone, '344a-business-app-loyalty-rules-saved');
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<Record<string, unknown>>(
    await request.get(`/v1/organizations/${org.id}/loyalty/program`, { headers: owner }),
  );
  expect(saved).toMatchObject({
    enabled: false,
    mode: 'points',
    pointsPerUnit: 5,
    spendUnitGrosze: 1000,
    pointsValidityDays: 180,
    maxDiscountPercent: 30,
  });
});
