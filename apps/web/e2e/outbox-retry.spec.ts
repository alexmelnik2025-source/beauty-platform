import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 841 (owner's rule: errors where the action is): the platform administrator's email queue
 * page. A refused "Wyślij wszystkie ponownie" or "Wyślij ponownie" is said right under the pressed
 * button (screenshots 841-outbox-retry-all-error, 841-outbox-retry-one-error), not as a box above
 * the counters. The e2e server lists no administrator, so the queue answers are stand-ins here.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `outbox-retry-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const TOO_MANY = 'Zbyt wiele prób. Odczekaj chwilę.';
// The button is described by the error with its "!" mark in front.
const TOO_MANY_END = /Zbyt wiele prób\. Odczekaj chwilę\.$/;
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test.use({ viewport: PHONE });

test('a refused resend is said under the pressed button (task 841)', async ({ page, request }) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Admin' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: `Kolejka ${run}` } }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `Kolejka ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );

  // The queue as the server would show it to an administrator.
  await page.route('**/v1/admin/outbox', (route) =>
    route.fulfill({
      json: {
        status: 'warning',
        pending: 2,
        due: 0,
        oldestDueSeconds: 0,
        failed: 2,
        sentLast24h: 14,
      },
    }),
  );
  const lastAttemptAt = new Date().toISOString();
  await page.route('**/v1/admin/outbox/failed', (route) =>
    route.fulfill({
      json: [
        {
          id: FIRST,
          type: 'booking_confirmation',
          attempts: 5,
          lastAttemptAt,
          lastError: 'SMTP 421',
        },
        { id: SECOND, type: 'reminder', attempts: 5, lastAttemptAt, lastError: 'SMTP 450' },
      ],
    }),
  );
  await page.route('**/v1/admin/outbox/retry', (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'slow down' } } }),
  );

  await page.setExtraHTTPHeaders(freshAddress());
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app(?!\/onboarding)/);
  await page.goto('/pl/app/admin/outbox');
  await expect(page.getByText('booking_confirmation')).toBeVisible();

  // "Wyślij wszystkie ponownie" refused: said under it, the list stays, nothing at the top.
  const all = page.getByRole('button', { name: 'Wyślij wszystkie ponownie' });
  await all.click();
  await expect(page.locator('#outbox-retry-all-error')).toHaveText(TOO_MANY);
  await expect(all).toHaveAccessibleDescription(TOO_MANY_END);
  await expect(all).toBeEnabled();
  await expect(page.locator('.alert')).toHaveCount(0);
  await expect(page.getByText('reminder', { exact: true })).toBeVisible();
  await shot(page, '841-outbox-retry-all-error');

  // One email's "Wyślij ponownie" refused: said under that row's button only.
  const second = page.getByRole('button', { name: 'Wyślij ponownie', exact: true }).nth(1);
  await second.click();
  await expect(page.locator(`#outbox-retry-error-${SECOND}`)).toHaveText(TOO_MANY);
  await expect(second).toHaveAccessibleDescription(TOO_MANY_END);
  await expect(page.locator('#outbox-retry-all-error')).toHaveCount(0);
  await expect(page.locator(`#outbox-retry-error-${FIRST}`)).toHaveCount(0);
  await expect(page.locator('.alert')).toHaveCount(0);
  await shot(page, '841-outbox-retry-one-error');
});
