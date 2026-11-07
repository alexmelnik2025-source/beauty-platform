import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 279: "Kolejność" above the cabinet's client list — A–Z (the default), the latest visit
 * first, or the most visits first. Zenon came three times, Adam once (the latest), Basia never.
 * The chosen order stays in the address (a reload keeps it). Screenshot 279.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `sort-owner-${run}@example.com`;
const HOUR = 60 * 60_000;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the owner sorts the clients by the latest visit and by the number of visits', async ({
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
    await request.post('/v1/organizations', { headers: owner, data: { name: 'Kolejność Barber' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Kolejność Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const salon = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${salon}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${salon}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  const client = async (name: string, phone: string) =>
    (
      await json<{ id: string }>(
        await request.post(`/v1/organizations/${org.id}/customers`, {
          headers: owner,
          data: { name, phone },
        }),
      )
    ).id;
  const zenon = await client('Zenon Stały', '+48600000791');
  const adam = await client('Adam Świeży', '+48600000792');
  await client('Basia Bez Wizyt', '+48600000793');
  // Visits entered afterwards as "came", on 5-minute marks a few hours ago.
  const visit = (customerId: string, hoursAgo: number) =>
    request
      .post(`${salon}/appointments`, {
        headers: owner,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start: new Date(
            Math.floor((Date.now() - hoursAgo * HOUR) / 300_000) * 300_000,
          ).toISOString(),
          customerId,
          alreadyHappened: true,
          allowOutsideHours: true,
        },
      })
      .then(json);
  await visit(zenon, 6);
  await visit(zenon, 5);
  await visit(zenon, 4);
  await visit(adam, 2);

  const desk = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: address,
  });
  const page = await desk.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\//);
  await page.goto('/pl/app/clients');

  const rows = page.locator('.list-row');
  const order = page.getByLabel('Kolejność', { exact: true });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Adam Świeży');
  await expect(rows.nth(1)).toContainText('Basia Bez Wizyt');
  await expect(rows.nth(2)).toContainText('Zenon Stały');

  await order.selectOption({ label: 'Najwięcej wizyt' });
  await expect(rows.nth(0)).toContainText('Zenon Stały');
  await expect(rows.nth(1)).toContainText('Adam Świeży');
  await expect(rows.nth(2)).toContainText('Basia Bez Wizyt');
  await expect(page).toHaveURL(/sort=visits/);
  await shot(page, '279-clients-sort');

  await order.selectOption({ label: 'Ostatnia wizyta — najnowsze' });
  await expect(rows.nth(0)).toContainText('Adam Świeży');
  await expect(rows.nth(1)).toContainText('Zenon Stały');
  await expect(rows.nth(2)).toContainText('Basia Bez Wizyt');

  // A reload keeps the order (task 272: the address).
  await page.reload();
  await expect(order).toHaveValue('recent');
  await expect(rows.nth(0)).toContainText('Adam Świeży');

  // A filter with its own order hides the choice.
  await page.getByRole('button', { name: /Nowi \(30 dni\)/ }).click();
  await expect(order).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await desk.close();
});
