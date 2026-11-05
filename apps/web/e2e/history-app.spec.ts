import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 150: "Dziennik zmian" in the business app (web preview of apps/mobile-business). The
 * owner sees on the phone who added the service and the specialist and who changed the hours.
 * Screenshot 150.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `history-app-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

/** The business app's sign-in: email → code from Mailpit → the day calendar. */
async function signInToApp(app: Page, url: string, email: string) {
  await app.goto(url);
  await app.getByLabel('E-mail lub telefon').fill(email);
  await app.getByRole('button', { name: 'Wyślij kod' }).click();
  const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
  await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
  await app.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
}

test('the owner reads the change log in the business app (task 150)', async ({
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
        name: `History App ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia Nowak', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '17:00' }],
        })),
      },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // The code sign-in comes from an address of its own too (sign-in limits are per address).
      extraHTTPHeaders: freshAddress(),
    });
    const app = await context.newPage();
    await signInToApp(app, businessApp.url, OWNER);
    await app.getByRole('button', { name: 'Dziennik zmian' }).click();
    await expect(app.getByRole('heading', { name: 'Dziennik zmian' })).toBeVisible();
    // Newest first: the hours, the specialist, the service — each with who did it.
    const titles = app.getByText(/^(Zmieniono godziny pracy|Dodano specjalistę|Dodano usługę)/);
    await expect(titles).toHaveText([
      'Zmieniono godziny pracy: Kasia Nowak',
      'Dodano specjalistę: Kasia Nowak',
      'Dodano usługę: Strzyżenie męskie',
    ]);
    await expect(app.getByText(/^Aleksander Owner · /).first()).toBeVisible();
    await shot(app, '150-business-app-history');
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
