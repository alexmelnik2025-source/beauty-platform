import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 259: "Usługi bez wizyt" in the report — bookable services nobody booked in the period,
 * in price-list order, with a link to "Usługi" (screenshot 259); the same in the business app's
 * "Raporty" (259-a).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `unbooked-owner-${run}@example.com`;
const DESKTOP = { width: 1440, height: 900 };

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

test('the report lists the services nobody booked', async ({ browser, request }) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `Barber Usługi ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const beardCategory = await json<{ id: string }>(
    await request.post(`${base}/service-categories`, {
      headers: owner,
      data: { name: 'Broda i wąsy' },
    }),
  );
  const service = async (name: string, priceGrosze: number, categoryId?: string) =>
    json<{ id: string }>(
      await request.post(`${base}/services`, {
        headers: owner,
        data: { name, durationMinutes: 30, priceGrosze, bufferMinutes: 0, categoryId },
      }),
    );
  const haircut = await service('Strzyżenie męskie', 9000);
  const beard = await service('Trymowanie brody', 5000, beardCategory.id);
  await service('Koloryzacja brody', 7000, beardCategory.id);
  await service('Golenie brzytwą', 6000);
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Ilian', serviceIds: [haircut.id, beard.id] },
    }),
  );
  // Visits can't be booked in the past: book tomorrow and move them two days back.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const ids: string[] = [];
  for (const [i, serviceId] of [haircut.id, beard.id].entries()) {
    const booked = await json<{ id: string }>(
      await request.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId,
          staffId: staff.id,
          start: new Date(
            Date.UTC(
              tomorrow.getUTCFullYear(),
              tomorrow.getUTCMonth(),
              tomorrow.getUTCDate(),
              9 + i,
            ),
          ).toISOString(),
          allowOutsideHours: true,
          customer: {
            name: 'Jan Kowalski',
            phone: '+48600000259',
            email: `jan-${run}@example.com`,
          },
        },
      }),
    );
    ids.push(booked.id);
  }
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days', status = 'completed' WHERE id IN ('${ids.join("','")}')`,
  ]);

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const unbooked = page.getByTestId('report-unbooked');
  await unbooked.scrollIntoViewIfNeeded();
  await expect(unbooked.getByRole('heading')).toHaveText('Usługi bez wizyt');
  const items = unbooked.getByRole('listitem');
  await expect(items).toHaveCount(2);
  // The grouped service first, as on the booking page.
  await expect(items.nth(0)).toContainText('Koloryzacja brody');
  await expect(items.nth(0)).toContainText('Broda i wąsy');
  await expect(items.nth(0)).toContainText(/70,00\s*zł/);
  await expect(items.nth(1)).toContainText('Golenie brzytwą');
  await expect(unbooked).not.toContainText('Strzyżenie męskie');
  await shot(page, '259-report-unbooked');
  await unbooked.getByRole('link', { name: 'Otwórz usługi' }).click();
  await page.waitForURL(/\/pl\/app\/services/);
  await context.close();

  const businessApp = await serveApp('mobile-business');
  try {
    const app = await (
      await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: 'pl-PL',
        isMobile: true,
      })
    ).newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await app.getByRole('button', { name: 'Raporty' }).click();
    await app.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    const block = app.getByTestId('report-unbooked');
    await block.scrollIntoViewIfNeeded();
    await expect(block.getByText('Usługi bez wizyt', { exact: true })).toBeVisible();
    await expect(block.getByText('Koloryzacja brody', { exact: true })).toBeVisible();
    await expect(block.getByText('Golenie brzytwą', { exact: true })).toBeVisible();
    await shot(app, '259-a-business-app-report-unbooked');
  } finally {
    businessApp.server.close();
  }
});
