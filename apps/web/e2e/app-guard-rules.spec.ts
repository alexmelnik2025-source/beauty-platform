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
 * Task 349: "Zmień zasady" in "Ochrona przed odwołaniami" of the business app (web preview of
 * apps/mobile-business). Switching on without rules points to "Zmień zasady"; the owner sets
 * "3 in 14 days" and "2 no-shows", "Tylko telefonicznie", fixes a wrong number and switches the
 * protection on. Screenshot 349.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-guard-rules-owner-${run}@example.com`;
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

test('business app: the owner sets the cancellation protection rules', async ({
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

    await phone.getByRole('button', { name: 'Ochrona przed odwołaniami' }).click();
    await expect(phone.getByText('Żadna zasada nie jest ustawiona.')).toBeVisible();
    await phone.getByRole('button', { name: 'Włącz ochronę' }).click();
    await expect(
      phone.getByText('Najpierw ustaw co najmniej jedną zasadę — „Zmień zasady”.'),
    ).toBeVisible();

    await phone.getByRole('button', { name: 'Zmień zasady', exact: true }).click();
    await phone.getByRole('checkbox', { name: 'Częste odwołania i przeniesienia' }).click();
    await phone.getByLabel('Ile odwołań lub przeniesień (1–50)').fill('3');
    await phone.getByLabel('W ciągu ilu dni (1–365)').fill('14');
    await phone.getByRole('checkbox', { name: 'Nieobecności' }).click();
    await phone.getByLabel('Ile nieobecności (1–20)').fill('25');
    await phone.getByRole('radio', { name: 'Tylko telefonicznie' }).click();
    await phone.getByRole('button', { name: 'Zapisz zasady' }).click();
    await expect(phone.getByText('Nieobecności: liczba od 1 do 20.')).toBeVisible();
    await phone.getByLabel('Ile nieobecności (1–20)').fill('2');
    await shot(phone, '349-business-app-guard-rules');
    await phone.getByRole('button', { name: 'Zapisz zasady' }).click();
    await expect(phone.getByText('Zasady ochrony zapisane.')).toBeVisible();
    await expect(phone.getByText('• Odwołania lub przeniesienia: 3 w ciągu 14 dni')).toBeVisible();
    await expect(phone.getByText('• Nieobecności: 2')).toBeVisible();
    await expect(phone.getByText('Co wtedy: Tylko telefonicznie')).toBeVisible();

    await phone.getByRole('button', { name: 'Włącz ochronę' }).click();
    await expect(phone.getByText('Ochrona jest włączona.')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<Record<string, unknown>>(
    await request.get(`/v1/organizations/${org.id}/locations/${location.id}/cancellation-guard`, {
      headers: owner,
    }),
  );
  expect(saved).toMatchObject({
    enabled: true,
    maxChanges: 3,
    windowHours: 14 * 24,
    lateCancelMinutes: null,
    maxNoShows: 2,
    action: 'phone_only',
  });
});
