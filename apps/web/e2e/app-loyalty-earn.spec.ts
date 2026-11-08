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
 * Task 347: "Pieczątki i punkty za usługi" in "Program lojalnościowy" of the business app (web
 * preview of apps/mobile-business). The owner gives "Broda" 2 stamps and "Strzyżenie" none; a
 * wrong number is pointed out with the service's name. Screenshot 347.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-loyalty-earn-owner-${run}@example.com`;
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

test('business app: the owner sets stamps per service', async ({ browser, request }) => {
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
  const services: Record<string, string> = {};
  for (const [name, priceGrosze] of [
    ['Strzyżenie', 9000],
    ['Broda', 6000],
    ['Mycie głowy', 2000],
  ] as const) {
    const service = await json<{ id: string }>(
      await request.post(`${base}/services`, {
        headers: owner,
        data: { name, durationMinutes: 30, priceGrosze, bufferMinutes: 0 },
      }),
    );
    services[name] = service.id;
  }

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
    await expect(phone.getByText('Wszystkie usługi według zasady ogólnej.')).toBeVisible();
    await phone.getByRole('button', { name: 'Zmień pieczątki i punkty za usługi' }).click();
    await phone.getByLabel('Broda: pieczątki (puste — zasada ogólna)').fill('2,5');
    await phone.getByLabel('Strzyżenie: pieczątki (puste — zasada ogólna)').fill('0');
    await phone.getByRole('button', { name: 'Zapisz za usługi' }).click();
    await expect(
      phone.getByText('Broda: wpisz liczbę od 0 do 100 000 albo zostaw puste.'),
    ).toBeVisible();
    await phone.getByLabel('Broda: pieczątki (puste — zasada ogólna)').fill('2');
    await shot(phone, '347-business-app-loyalty-earn-rules');
    await phone.getByRole('button', { name: 'Zapisz za usługi' }).click();
    await expect(phone.getByText('Pieczątki i punkty za usługi zapisane.')).toBeVisible();
    await expect(phone.getByText('Strzyżenie · 0 pieczątki')).toBeVisible();
    await expect(phone.getByText('Broda · 2 pieczątki')).toBeVisible();
    await expect(phone.getByText('Mycie głowy ·', { exact: false })).toHaveCount(0);
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<{ earnRules: { serviceId: string; points: number }[] }>(
    await request.get(`/v1/organizations/${org.id}/loyalty/program`, { headers: owner }),
  );
  expect(
    saved.earnRules
      .map((r) => [r.serviceId, r.points])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual(
    [
      [services['Strzyżenie'], 0],
      [services['Broda'], 2],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
});
