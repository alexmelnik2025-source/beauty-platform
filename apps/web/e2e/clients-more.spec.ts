import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 277: "Pokaż więcej klientów". The salon has 105 clients; the cabinet's "Klienci" shows
 * the first 100 and a "Pokaż więcej klientów" button, which adds the last five below and then
 * disappears. Screenshot 277.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `more-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };
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
});
