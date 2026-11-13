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
 * Task 395: "Produkty". The owner keeps the salon's list of products in "Usługi" (screenshot
 * 395), notes what the client bought in the card of a visit that took place (395-a) and sees
 * "Sprzedaż produktów" in "Raporty", apart from the visit revenue (395-b).
 * Task 396: the same in the business app — a tap on a product in the visit card (396) and
 * "Sprzedaż produktów" in its report (396-a); the list of products in "Usługi" (task 397, 397).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `products-owner-${run}@example.com`;
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

test('the owner sells a product at a visit; the report counts it apart', async ({
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
  // Visits can't be booked in the past: book tomorrow at 10:00 UTC and move it two days back.
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
          phone: '+48600000395',
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

  // "Usługi" → "Produkty": two products, then a new price for one.
  await page.goto('/pl/app/services');
  const products = page.getByTestId('products');
  await products.scrollIntoViewIfNeeded();
  await expect(products.getByText('Na liście nie ma jeszcze produktów.')).toBeVisible();
  for (const [name, price] of [
    ['Pomada matowa', '45'],
    ['Szampon', '30,50'],
  ] as const) {
    await products.getByLabel('Nowy produkt').fill(name);
    await products.getByLabel(/^Cena \(/).fill(price);
    await products.getByRole('button', { name: '+ Dodaj produkt' }).click();
    await expect(products.getByLabel(`Nazwa — ${name}`)).toBeVisible();
  }
  await expect(products.getByTestId('product-row')).toHaveCount(2);
  await products.getByLabel('Cena — Pomada matowa').fill('49');
  await products
    .getByTestId('product-row')
    .filter({ has: page.getByLabel('Nazwa — Pomada matowa') })
    .getByRole('button', { name: 'Zapisz' })
    .click();
  await expect(products.getByLabel('Cena — Pomada matowa')).toHaveValue('49');
  await shot(page, '395-owner-products');

  // The visit card: the client buys two pomades and a shampoo; one shampoo was a mistake.
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();
  const card = page.getByRole('dialog');
  const sold = card.getByTestId('visit-products');
  // The list is by name: 1 = Pomada matowa, 2 = Szampon.
  await sold.getByLabel('Wybierz produkt').selectOption({ index: 1 });
  await sold.getByLabel('Ilość').fill('2');
  await sold.getByRole('button', { name: '+ Dodaj' }).click();
  await expect(sold).toContainText(/Pomada matowa × 2/);
  await sold.getByLabel('Wybierz produkt').selectOption({ index: 2 });
  await sold.getByRole('button', { name: '+ Dodaj' }).click();
  await expect(sold).toContainText(/Produkty: 128,50\s*zł/);
  await sold.getByRole('button', { name: 'Usuń — Szampon' }).click();
  await expect(sold).toContainText(/Produkty: 98,00\s*zł/);
  await sold.scrollIntoViewIfNeeded();
  await shot(page, '395-a-visit-products');
  await page.keyboard.press('Escape');

  // "Raporty": products apart from the visit revenue (the visit itself was not paid).
  await page.goto('/pl/app/reports');
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const report = page.getByTestId('report-products');
  await report.scrollIntoViewIfNeeded();
  await expect(report.getByRole('heading')).toHaveText(/Sprzedaż produktów: 98,00\s*zł/);
  await expect(report).toContainText('Pomada matowa');
  await expect(report).toContainText(/2 szt\. · 98,00\s*zł/);
  await shot(page, '395-b-report-products');
  await context.close();

  // The business app (its web preview): one more shampoo in the visit card, then the report.
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
    // Task 397: "Usługi" → "Produkty" — a new product from the phone.
    await app.getByRole('button', { name: 'Usługi' }).click();
    const appList = app.getByTestId('products');
    await appList.getByLabel('Nowy produkt').fill('Wosk');
    await appList.getByLabel('Cena produktu (PLN)').last().fill('25');
    await appList.getByRole('button', { name: '+ Dodaj produkt' }).click();
    await expect(appList.getByText('Wosk', { exact: true })).toBeVisible();
    await expect(appList.getByText('Pomada matowa', { exact: true })).toBeVisible();
    await appList.getByRole('button', { name: 'Dodaj produkt' }).scrollIntoViewIfNeeded();
    await shot(app, '397-business-app-products');
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const jan = app.getByRole('button', { name: /Jan Kowalski/ }).first();
    for (let back = 0; back < 3 && !(await jan.isVisible()); back++) {
      await app.getByRole('button', { name: 'Poprzedni dzień' }).click();
      await app.waitForTimeout(800);
    }
    await jan.click();
    const appSold = app.getByTestId('visit-products');
    await expect(appSold).toContainText(/Pomada matowa × 2/);
    await appSold.getByRole('button', { name: 'Dodaj produkt — Szampon' }).click();
    await expect(appSold).toContainText(/PRODUKTY: 128,50\s*zł/);
    await appSold.scrollIntoViewIfNeeded();
    await shot(app, '396-business-app-visit-products');
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await app.getByRole('button', { name: 'Raporty' }).click();
    await app.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    const appReport = app.getByTestId('report-products');
    await appReport.scrollIntoViewIfNeeded();
    await expect(appReport).toContainText(/Sprzedaż produktów: 128,50\s*zł/);
    await expect(appReport).toContainText(/1 szt\. · 30,50\s*zł/);
    await shot(app, '396-a-business-app-report-products');
  } finally {
    businessApp.server.close();
  }
});
