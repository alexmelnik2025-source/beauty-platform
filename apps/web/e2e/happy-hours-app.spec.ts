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
 * Task 99: "Happy hours" in the business app (web preview of apps/mobile-business). The owner
 * adds cheaper hours for one specialist on Tuesdays and Thursdays, sees them in the list and
 * removes them again. Screenshots 99–99b.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `happy-app-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544): the API allows 10 sign-ups an hour from one.
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

test('the owner adds and removes happy hours in the business app (task 99)', async ({
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
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Kasia' } }),
  );
  await json(
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Marek' } }),
  );
  await json(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // Sign-ins from this test's own address too, so other tests keep their login limit.
      extraHTTPHeaders: ADDRESS,
    });
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await app.getByRole('button', { name: 'Happy hours' }).click();
    await expect(app.getByRole('heading', { name: 'Happy hours' })).toBeVisible();
    await expect(app.getByText('Nie ma jeszcze tańszych godzin.')).toBeVisible();

    // ── Tuesdays and Thursdays 10:00–13:00, −20%, only Kasia ─────────────
    await app.getByRole('button', { name: '+ Dodaj tańsze godziny' }).click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Wybierz co najmniej jeden dzień.')).toBeVisible();
    await app.getByRole('button', { name: 'wt.', exact: true }).click();
    await app.getByRole('button', { name: 'czw.', exact: true }).click();
    await app.getByLabel('Od (np. 10:00)').fill('10:00');
    await app.getByLabel('Do (np. 13:00)').fill('13:00');
    await app.getByLabel('Rabat, %').fill('20');
    await app.getByRole('button', { name: 'Kasia', exact: true }).click();
    await shot(app, '99-business-app-happy-hours-add');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano tańsze godziny.')).toBeVisible();
    await expect(app.getByText('−20%', { exact: true })).toBeVisible();
    await expect(app.getByText('wt., czw. · 10:00–13:00')).toBeVisible();
    await expect(app.getByText('Specjaliści: Kasia')).toBeVisible();
    await expect(app.getByText('Usługi: wszystkie')).toBeVisible();
    await shot(app, '99b-business-app-happy-hours');

    const saved = await json<{ rules: { weekdays: number[]; staffIds: string[] }[] }>(
      await request.get(`${base}/happy-hours`, { headers: owner }),
    );
    expect(saved.rules).toMatchObject([{ weekdays: [2, 4], staffIds: [kasia.id] }]);

    // ── Removed again ──────────────────────────────────────────────────
    await app.getByRole('button', { name: 'Usuń tańsze godziny: wt., czw. · 10:00–13:00' }).click();
    await expect(app.getByText('Usunąć te tańsze godziny?')).toBeVisible();
    await app.getByRole('button', { name: 'Tak, usuń' }).click();
    await expect(app.getByText('Usunięto tańsze godziny.')).toBeVisible();
    await expect(app.getByText('Nie ma jeszcze tańszych godzin.')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
