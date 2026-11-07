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

/**
 * Task 229: tips. In the card of a visit that took place the owner notes "Napiwek" 15,50 zł
 * (screenshot 229); "Kasa dnia" shows it apart from the visit money (229-a) and "Raporty" has
 * "Napiwki" by specialist (229-b).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `tip-owner-${run}@example.com`;
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

test('the owner notes a tip; the till and the report show it apart from the revenue', async ({
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
          phone: '+48600000229',
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
  const till = page.getByTestId('till');
  await expect(till).toContainText('przyszli, nieopłacone: 1');
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();
  const card = page.getByRole('dialog');
  await expect(card).toContainText('Odbyła się');
  const tip = card.getByLabel(/Napiwek/);
  await expect(tip).toHaveValue('');
  const save = card.getByRole('button', { name: 'Zapisz napiwek' });
  await expect(save).toBeDisabled();
  await tip.fill('15,5x');
  await expect(card.getByText('Wpisz kwotę, np. 15 lub 15,50.')).toBeVisible();
  await expect(save).toBeDisabled();
  await tip.fill('15,50');
  await save.click();
  await expect(card.getByText('Zmieniono napiwek')).toBeVisible();
  await expect(tip).toHaveValue('15,50');
  await expect(save).toBeDisabled();
  // Pay for the visit too: the tip is not part of the price.
  await card.getByRole('button', { name: 'Opłacono', exact: true }).click();
  await expect(card.getByTestId('paid-chip')).toBeVisible();
  await tip.scrollIntoViewIfNeeded();
  await shot(page, '229-visit-tip');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  await expect(till).toContainText(/Kasa dnia: 90,00\s*zł/);
  await expect(till.getByTestId('till-tips')).toHaveText(/Napiwki 15,50\s*zł/);
  await shot(page, '229-a-calendar-till-tips');

  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const tips = page.getByTestId('report-tips');
  await tips.scrollIntoViewIfNeeded();
  await expect(tips.getByRole('heading')).toHaveText(/Napiwki: 15,50\s*zł/);
  await expect(tips.getByRole('meter', { name: 'Ilian' })).toHaveAttribute('aria-valuenow', '100');
  await expect(tips.getByRole('listitem')).toContainText('wizyty z napiwkiem: 1');
  await shot(page, '229-b-report-tips');
  await context.close();
});
