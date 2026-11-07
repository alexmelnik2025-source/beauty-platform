import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 277: "Pokaż więcej klientów". The salon has 105 clients; the cabinet's "Klienci" shows
 * the first 100 and a "Pokaż więcej klientów" button, which adds the last five below and then
 * disappears. Task 278: the same in the business app — 50 at a time, "Pokaż więcej klientów"
 * twice brings all 105. Screenshots 277, 278.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `more-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const CLIENTS = 105;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the owner opens the next clients with "Pokaż więcej klientów"', async ({
  browser,
  request,
}) => {
  const address = freshAddress();
  await json(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: address,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'Więcej Barber' } }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Więcej Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  // "Klient 001" … "Klient 105": the names sort in the order they are made.
  for (let i = 1; i <= CLIENTS; i++) {
    const n = String(i).padStart(3, '0');
    await json(
      await request.post(`/v1/organizations/${org.id}/customers`, {
        headers: owner,
        data: { name: `Klient ${n}`, phone: `+48601000${n}` },
      }),
    );
  }

  const desk = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: address,
  });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\//);
  await cabinet.goto('/pl/app/clients');

  const rows = cabinet.locator('.list-row');
  await expect(rows).toHaveCount(100);
  await expect(rows.last()).toContainText('Klient 100');
  const more = cabinet.getByRole('button', { name: 'Pokaż więcej klientów' });
  await more.scrollIntoViewIfNeeded();
  await shot(cabinet, '277-clients-show-more');
  await more.click();
  await expect(rows).toHaveCount(CLIENTS);
  await expect(rows.last()).toContainText('Klient 105');
  await expect(more).toHaveCount(0);

  // A search starts the list again from its first page.
  await cabinet.getByRole('searchbox').fill('Klient 10');
  await expect(rows).toHaveCount(6);
  await expect(more).toHaveCount(0);
  await desk.close();

  // Task 278: the business app — 50 clients at a time.
  const businessApp = await serveApp('mobile-business');
  try {
    const phone = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await phone.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await app.getByRole('button', { name: 'Klienci' }).click();
    const cards = app.getByRole('button', { name: /^Karta klienta: / });
    await expect(cards).toHaveCount(50);
    const appMore = app.getByRole('button', { name: 'Pokaż więcej klientów' });
    await appMore.click();
    await expect(cards).toHaveCount(100);
    await appMore.scrollIntoViewIfNeeded();
    await shot(app, '278-business-app-show-more');
    await appMore.click();
    await expect(cards).toHaveCount(CLIENTS);
    await expect(cards.last()).toContainText('Klient 105');
    await expect(appMore).toHaveCount(0);
    await phone.close();
  } finally {
    businessApp.server.close();
  }
});
