import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Launch task L5: a salon outside Poland. A new owner in Istanbul creates the salon: the country
 * and time zone come from the browser, the currency follows (lira), the postal code is not a
 * Polish one; Settings show both and let the owner change them. Screenshots 69–69b.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `istanbul-owner-${run}@example.com`;

test.use({ timezoneId: 'Europe/Istanbul', viewport: { width: 1440, height: 900 } });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('an owner in Istanbul creates a salon in the Turkish time zone with prices in lira', async ({
  page,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Emre Kaya' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );

  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/onboarding/);

  const zone = page.getByLabel('Kraj i strefa czasowa');
  await expect(zone).toHaveValue('Europe/Istanbul');
  await expect(zone.locator('option:checked')).toHaveText('Turcja (Istanbul)');
  await expect(page.getByLabel('Waluta cen')).toHaveValue('TRY');
  await page.getByLabel('Nazwa firmy').fill('Berber Kadıköy');
  await page.getByLabel('Ulica i numer').fill('Moda Cd. 1');
  await page.getByLabel('Miasto').fill('İstanbul');
  // A Turkish postal code: five digits, not the Polish 00-000.
  await page.getByLabel('Kod pocztowy').fill('34710');
  await shot(page, '69-onboarding-istanbul');
  await page.getByRole('button', { name: 'Utwórz salon' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);

  await page.goto('/pl/app/settings');
  await expect(page.getByLabel('Kraj i strefa czasowa')).toHaveValue('Europe/Istanbul');
  await expect(page.getByLabel('Waluta cen')).toHaveValue('TRY');
  // Changing the zone does not change the currency (prices would need correcting by hand).
  await page.getByLabel('Kraj i strefa czasowa').selectOption('Europe/Tirane');
  await page.locator('form.page').getByRole('button', { name: 'Zapisz' }).click();
  await expect(page.getByText('Zapisano')).toBeVisible();
  await expect(page.getByLabel('Waluta cen')).toHaveValue('TRY');
  await page.getByLabel('Kraj i strefa czasowa').scrollIntoViewIfNeeded();
  await shot(page, '69b-settings-time-zone');
  await page.reload();
  await expect(page.getByLabel('Kraj i strefa czasowa')).toHaveValue('Europe/Tirane');
});
