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
 * Task 346: "Dodatkowe pieczątki i punkty" in "Program lojalnościowy" of the business app (web
 * preview of apps/mobile-business). The owner adds "Spokojne dni": ×2 on Monday and Tuesday at
 * Kasia; a rule that gives nothing is pointed out first. Screenshot 346.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-loyalty-bonus-owner-${run}@example.com`;
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

test('business app: the owner adds an extra stamps rule', async ({ browser, request }) => {
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

  const kasia = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations/${location.id}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia' },
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
    await expect(phone.getByText(/^Brak zasad — każda wizyta/)).toBeVisible();
    await phone.getByRole('button', { name: 'Zmień zasady dodatkowe' }).click();
    await phone.getByRole('button', { name: '+ Dodaj zasadę' }).click();
    await phone.getByLabel('Nazwa zasady 1').fill('Spokojne dni');
    await phone.getByLabel('Mnożnik × (zasada 1)').fill('1');
    await phone.getByRole('button', { name: 'Zapisz zasady dodatkowe' }).click();
    await expect(phone.getByText(/^Zasada 1: musi coś dawać/)).toBeVisible();
    await phone.getByLabel('Mnożnik × (zasada 1)').fill('2');
    await phone.getByRole('button', { name: 'pon.', exact: true }).click();
    await phone.getByRole('button', { name: 'wt.', exact: true }).click();
    await phone.getByRole('button', { name: 'Kasia', exact: true }).click();
    await shot(phone, '346-business-app-loyalty-bonus-rules');
    await phone.getByRole('button', { name: 'Zapisz zasady dodatkowe' }).click();
    await expect(phone.getByText('Zasady dodatkowe zapisane.')).toBeVisible();
    await expect(phone.getByText('Spokojne dni · ×2')).toBeVisible();
    await expect(phone.getByText('pon., wt. · Kasia')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<{
    rules: { name: string; staff: { id: string }[]; weekdays: number[]; multiplier: number }[];
  }>(await request.get(`/v1/organizations/${org.id}/loyalty/bonus-rules`, { headers: owner }));
  expect(saved.rules).toEqual([
    expect.objectContaining({
      name: 'Spokojne dni',
      staff: [expect.objectContaining({ id: kasia.id })],
      weekdays: [1, 2],
      multiplier: 2,
      extraPoints: 0,
      withinDays: null,
    }),
  ]);
});
