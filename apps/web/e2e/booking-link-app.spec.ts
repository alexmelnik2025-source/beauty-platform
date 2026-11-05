import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 152: "Link do rezerwacji" in the business app (web preview of apps/mobile-business).
 * The owner sees the salon's booking link, a hint while online booking is off, and copies the
 * link (this browser has no share menu). Screenshot 152.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `booking-link-app-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the owner shares the booking link from the business app (task 152)', async ({
  browser,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const verify = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(verify.text)?.[1];
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
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ slug: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `Link App ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );

  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    // The code sign-in comes from an address of its own too (sign-in limits are per address).
    extraHTTPHeaders: freshAddress(),
  });
  // No share menu in this browser: the link goes to the clipboard.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
  });
  const businessApp = await serveApp('mobile-business');
  try {
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await app.getByRole('button', { name: 'Link do rezerwacji' }).click();
    await expect(app.getByRole('heading', { name: 'Link do rezerwacji' })).toBeVisible();
    await expect(app.getByText(new RegExp(`/pl/b/${location.slug}$`))).toBeVisible();
    await expect(app.getByText(/Rezerwacja online jest wyłączona/)).toBeVisible();
    await app.getByRole('button', { name: 'Udostępnij link' }).click();
    await expect(app.getByText('Link skopiowany.')).toBeVisible();
    const copied = await app.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`/pl/b/${location.slug}$`));
    await shot(app, '152-business-app-booking-link');
  } finally {
    businessApp.server.close();
    await context.close();
  }
});
