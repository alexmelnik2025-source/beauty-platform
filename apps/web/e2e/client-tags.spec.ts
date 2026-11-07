import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Tasks 224 and 226: label chips above the client list — in the cabinet ("Klienci") and in the business
 * app (web preview of apps/mobile-business). The owner taps "stały klient" and sees only those
 * clients, then another label, then everyone again. Screenshots 224 and 224-a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `tags-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
/** The salon's own address: the API limits sign-ups and sign-ins per address. */
const OWNER_IP = freshAddress();

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: OWNER_IP,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('the owner filters the client list by a label (cabinet and business app)', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `Etykiety ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const clients: [string, string, string[]][] = [
    ['Jan Kowalski', '+48600000241', ['stały klient', 'broda']],
    ['Adam Nowak', '+48600000242', ['stały klient']],
    ['Piotr Zieliński', '+48600000243', ['broda', 'kosmetyki']],
    ['Ewa Wiśniewska', '+48600000244', []],
  ];
  for (const [name, phone, tags] of clients) {
    await json(
      await request.post(`/v1/organizations/${org.id}/customers`, {
        headers: owner,
        data: { name, phone, tags },
      }),
    );
  }

  // Cabinet.
  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    extraHTTPHeaders: OWNER_IP,
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\//);
  await page.goto('/pl/app/clients');
  const rows = page.locator('.list .list-row');
  await expect(rows).toHaveCount(4);
  const labels = page.getByRole('group', { name: 'Tagi' });
  // Most used first: "broda" and "stały klient" (2 each, alphabetically), then "kosmetyki".
  await expect(labels.getByRole('button')).toHaveText([
    'Wszystkie',
    'broda 2',
    'stały klient 2',
    'kosmetyki 1',
  ]);
  await labels.getByRole('button', { name: /stały klient/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Adam Nowak');
  await expect(rows.nth(1)).toContainText('Jan Kowalski');
  await expect(labels.getByRole('button', { name: /stały klient/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await shot(page, '224-client-tags');
  await labels.getByRole('button', { name: /kosmetyki/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Piotr Zieliński');
  await labels.getByRole('button', { name: 'Wszystkie' }).click();
  await expect(rows).toHaveCount(4);

  // Task 226: the card offers the salon's tags — one tap adds "broda" to Ewa.
  await rows.filter({ hasText: 'Ewa Wiśniewska' }).click();
  const card = page.getByRole('dialog');
  const offer = card.getByRole('group', { name: 'Dodaj tag' });
  await expect(offer.getByRole('button')).toHaveText(['+ broda', '+ stały klient', '+ kosmetyki']);
  await offer.getByRole('button', { name: '+ broda' }).click();
  await expect(card.getByLabel('Tagi (przez przecinek)')).toHaveValue('broda');
  await expect(offer.getByRole('button')).toHaveText(['+ stały klient', '+ kosmetyki']);
  await shot(page, '226-client-tag-suggestions');
  await card.locator('form.form').getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(card).toBeHidden();
  await expect(labels.getByRole('button', { name: /broda/ })).toHaveText('broda 3');
  await context.close();

  // Business app.
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
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await app.getByRole('button', { name: 'Klienci' }).click();
    await expect(app.getByRole('heading', { name: 'Klienci' })).toBeVisible();
    await expect(app.getByText('Ewa Wiśniewska')).toBeVisible();
    // Ewa got "broda" in the cabinet above: "broda" now has 3 clients.
    await expect(app.getByRole('radio', { name: 'broda · 3' })).toBeVisible();
    await app.getByRole('radio', { name: 'stały klient · 2' }).click();
    await expect(app.getByText('Adam Nowak')).toBeVisible();
    await expect(app.getByText('Jan Kowalski')).toBeVisible();
    await expect(app.getByText('Ewa Wiśniewska')).toHaveCount(0);
    await expect(app.getByText('Piotr Zieliński')).toHaveCount(0);
    await shot(app, '224-a-business-app-client-tags');
    await app.getByRole('radio', { name: 'Wszystkie' }).click();
    await expect(app.getByText('Ewa Wiśniewska')).toBeVisible();

    // Task 226: in the card, the salon's tags are one tap away.
    await app.getByRole('button', { name: 'Karta klienta: Adam Nowak' }).click();
    await app.getByRole('button', { name: 'Zmień notatkę i tagi' }).click();
    await app.getByRole('button', { name: 'Dodaj tag broda' }).click();
    await expect(app.getByLabel('Tagi', { exact: true })).toHaveValue('stały klient, broda');
    await expect(app.getByRole('button', { name: 'Dodaj tag broda' })).toHaveCount(0);
    await shot(app, '226-a-business-app-tag-suggestions');
    await phone.close();
  } finally {
    businessApp.server.close();
  }
});
