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
 * Task 227: how the client paid. In the visit card the owner picks "Karta" and marks
 * "Opłacono" (screenshot 227), changes it to "Gotówka" later (only the method changes), and
 * "Raporty" shows "Sposoby płatności" (227-a); the business app's report too (227-b).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `pay-owner-${run}@example.com`;
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

test('the owner marks how the client paid; the report shows the payment methods', async ({
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
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Ilian', serviceIds: [service.id] },
    }),
  );
  // Visits can't be booked in the past: book tomorrow at 10:00 UTC and move it a day back.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const booked = await json<{ id: string; version: number }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: new Date(
          Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 10),
        ).toISOString(),
        allowOutsideHours: true,
        customer: {
          name: 'Jan Kowalski',
          phone: '+48600000227',
          email: `jan-${run}@example.com`,
        },
      },
    }),
  );
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${booked.id}'`,
  ]);
  const visit = await json<{ date: string; version: number }>(
    await request.post(`${base}/appointments/${booked.id}/status`, {
      headers: owner,
      data: { version: booked.version, status: 'completed' },
    }),
  );

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();
  const card = page.getByRole('dialog');
  await expect(card).toContainText('Odbyła się');
  const methods = card.getByRole('group', { name: 'Sposób płatności' });
  await expect(methods.getByRole('button')).toHaveText([
    'Gotówka',
    'Karta',
    'BLIK',
    'Przelew',
    'Inna',
  ]);
  await methods.getByRole('button', { name: 'Karta' }).click();
  await expect(methods.getByRole('button', { name: 'Karta' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await card.getByRole('button', { name: 'Opłacono', exact: true }).click();
  await expect(card.getByTestId('paid-chip')).toHaveText('✓ Opłacono · Karta');
  await shot(page, '227-visit-payment-method');

  // The client paid in cash after all: only the method changes, the visit stays paid.
  await methods.getByRole('button', { name: 'Gotówka' }).click();
  await expect(card.getByTestId('paid-chip')).toHaveText('✓ Opłacono · Gotówka');
  await expect(card.getByText('Zmieniono sposób płatności')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cofnij opłatę (zwrot)' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const payments = page.getByTestId('report-payments');
  await payments.scrollIntoViewIfNeeded();
  await expect(payments.getByRole('heading', { name: 'Sposoby płatności' })).toBeVisible();
  await expect(payments.getByRole('meter', { name: 'Gotówka' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  );
  await expect(payments.getByRole('listitem')).toHaveCount(1);
  await expect(payments.getByRole('listitem')).toContainText(/90,00\s*zł/);
  await expect(payments.getByRole('listitem')).toContainText('wizyty: 1');
  await shot(page, '227-a-report-payment-methods');
  await context.close();

  // The business app (its web preview): the same split in "Raporty".
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
    const appPayments = app.getByTestId('report-payments');
    await appPayments.scrollIntoViewIfNeeded();
    await expect(appPayments).toContainText('Sposoby płatności');
    await expect(appPayments).toContainText('Gotówka');
    await expect(appPayments).toContainText(/90,00\s*zł · wizyty: 1/);
    await shot(app, '227-b-business-app-payment-methods');
  } finally {
    businessApp.server.close();
  }
});
