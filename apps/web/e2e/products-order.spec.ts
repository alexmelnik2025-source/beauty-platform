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
 * Task 473: "Tekst zamówienia" in "Usługi" → "Produkty" of the cabinet — the products to order as
 * a message for each supplier, with suggested numbers of pieces; the owner changes one and
 * copies it (screenshot 473). Task 474: "Wyślij zamówienie" in the business app — the same text
 * goes to the share sheet, in the web preview to the clipboard (screenshot 474).
 * Task 476: "Przyjmij dostawę" in the cabinet — Hairgum's part of the order arrives, with the
 * suggested numbers already written (screenshot 476). Task 477: the same in the business app for
 * Barber Hurt (screenshot 477).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `order-owner-${run}@example.com`;

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

const EXPECTED =
  'Zamówienie — Barber Hurt:\n- Wosk — 4 szt.\n\n' +
  'Zamówienie — Hairgum:\n- Pomada matowa — 5 szt.\n\n' +
  'Zamówienie — bez dostawcy:\n- Szampon — 1 szt.';

test('the owner sends the order for the products to order to each supplier', async ({
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
  for (const product of [
    // None left, few at 4 → 5 to get above the warning.
    {
      name: 'Pomada matowa',
      priceGrosze: 4900,
      stockQuantity: 0,
      lowStockAt: 4,
      supplier: 'Hairgum',
    },
    // 3 left, few at 3 → one more.
    { name: 'Szampon', priceGrosze: 3050, stockQuantity: 3, lowStockAt: 3 },
    // 2 left, few at 5 → 4 more.
    { name: 'Wosk', priceGrosze: 2500, stockQuantity: 2, lowStockAt: 5, supplier: 'Barber Hurt' },
    // Plenty: not in the order.
    { name: 'Olejek', priceGrosze: 4000, stockQuantity: 9, lowStockAt: 2, supplier: 'Hairgum' },
  ]) {
    await json(await request.post(`${base}/products`, { headers: owner, data: product }));
  }

  // The cabinet: "Tekst zamówienia" under "Do zamówienia".
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'pl-PL',
    // Password sign-ins are limited per address (task 153): this one comes from its own.
    extraHTTPHeaders: freshAddress(),
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.goto('/pl/app/services');
  const products = page.getByTestId('products');
  await expect(products.getByTestId('products-to-order')).toContainText('Barber Hurt — Wosk');
  await products.getByRole('button', { name: 'Tekst zamówienia' }).click();
  const text = products.getByRole('textbox', { name: 'Tekst zamówienia' });
  await expect(text).toHaveValue(EXPECTED);
  // The owner wants more wax this time.
  await text.fill(EXPECTED.replace('Wosk — 4 szt.', 'Wosk — 6 szt.'));
  await products.getByRole('button', { name: 'Kopiuj', exact: true }).click();
  await expect(products.getByText('Skopiowano — wklej w wiadomości do dostawcy.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    EXPECTED.replace('Wosk — 4 szt.', 'Wosk — 6 szt.'),
  );
  await products.getByTestId('products-order').scrollIntoViewIfNeeded();
  await shot(page, '473-owner-order-text');

  // Task 476: Hairgum's part of the order came — the suggested numbers are already there.
  await products.getByRole('button', { name: 'Przyjmij dostawę', exact: true }).click();
  const delivery = products.getByTestId('delivery');
  await expect(delivery.getByLabel('Przyszło — Pomada matowa')).toHaveValue('5');
  await expect(delivery.getByLabel('Przyszło — Wosk')).toHaveValue('4');
  await expect(delivery.getByLabel('Przyszło — Szampon')).toHaveValue('1');
  await expect(delivery.getByLabel('Przyszło — Olejek')).toHaveValue('');
  // Task 710: "Przyjmij dostawę" with no pieces typed is not silently off — said under the first field.
  for (const name of ['Pomada matowa', 'Wosk', 'Szampon']) {
    await delivery.getByLabel(`Przyszło — ${name}`).fill('');
  }
  await delivery.getByRole('button', { name: 'Przyjmij dostawę (0 szt.)' }).click();
  const firstCame = delivery.getByTestId('delivery-row').first().getByRole('textbox');
  await expect(firstCame).toBeFocused();
  await expect(firstCame).toHaveAttribute('aria-invalid', 'true');
  await expect(delivery.getByRole('alert')).toHaveText('Wpisz, ile sztuk przyszło.');
  await delivery.scrollIntoViewIfNeeded();
  await shot(page, '710-delivery-empty');
  await delivery.getByLabel('Przyszło — Pomada matowa').fill('5');
  await expect(delivery.locator('.field-error')).toHaveCount(0);
  await delivery.getByLabel('Przyszło — Wosk').fill('4');
  await delivery.getByLabel('Przyszło — Szampon').fill('1');
  // Task 670: zero pieces can't come — said under the field itself.
  await delivery.getByLabel('Przyszło — Olejek').fill('0');
  await expect(delivery.getByLabel('Przyszło — Olejek')).toHaveAccessibleDescription(
    /Wpisz liczbę od 1 do 100 000\.$/,
  );
  await delivery.scrollIntoViewIfNeeded();
  await shot(page, '670-delivery-field-error');
  // Task 710: pressing the button sends the cursor to the wrong number.
  await delivery.getByRole('button', { name: /^Przyjmij dostawę \(/ }).click();
  await expect(delivery.getByLabel('Przyszło — Olejek')).toBeFocused();
  await delivery.getByLabel('Przyszło — Olejek').fill('');
  await expect(delivery.locator('.field-error')).toHaveCount(0);
  await delivery.getByLabel('Pokaż produkty dostawcy').selectOption('Hairgum');
  await expect(delivery.getByTestId('delivery-row')).toHaveCount(2);
  await delivery.scrollIntoViewIfNeeded();
  await shot(page, '476-owner-delivery');
  // Task 811 (owner's rule: errors where the action is): a refused delivery is said under
  // "Przyjmij dostawę", not above the list; the typed pieces stay.
  const deliveryUrl = (url: URL) => url.pathname.endsWith('/products/delivery');
  await page.route(deliveryUrl, (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'slow down' } } }),
  );
  const takeDelivery = delivery.getByRole('button', { name: 'Przyjmij dostawę (5 szt.)' });
  await takeDelivery.click();
  await expect(delivery.locator('#delivery-save-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(takeDelivery).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(delivery.getByLabel('Przyszło — Pomada matowa')).toHaveValue('5');
  await expect(delivery.locator('.alert')).toHaveCount(0);
  await delivery.scrollIntoViewIfNeeded();
  await shot(page, '811-delivery-save-error');
  await page.unroute(deliveryUrl);
  await takeDelivery.click();
  await expect(products.getByTestId('delivery-done')).toHaveText(
    'Dostawa przyjęta: 5 szt., produktów: 1.',
  );
  await expect(products.getByLabel('W magazynie — Pomada matowa')).toHaveValue('5');
  await expect(products.getByLabel('W magazynie — Wosk')).toHaveValue('2');
  await expect(products.getByTestId('products-to-order')).not.toContainText('Pomada');
  await context.close();

  // The business app (its web preview): "Wyślij zamówienie" copies the same text.
  const businessApp = await serveApp('mobile-business');
  try {
    const appContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const app = await appContext.newPage();
    // No share menu in this browser: the order goes to the clipboard.
    await app.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    });
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await app.getByRole('tab', { name: 'Sklep', exact: true }).click();
    await app.getByRole('button', { name: 'Magazyn ▸', exact: true }).click();
    const appList = app.getByTestId('products');
    await appList.getByRole('button', { name: 'Wyślij zamówienie' }).click();
    await expect(
      appList.getByText('Zamówienie skopiowane — wklej je w wiadomości do dostawcy.'),
    ).toBeVisible();
    // The pomades came in the cabinet (task 476): only the rest is left to order.
    expect(await app.evaluate(() => navigator.clipboard.readText())).toBe(
      'Zamówienie — Barber Hurt:\n- Wosk — 4 szt.\n\nZamówienie — bez dostawcy:\n- Szampon — 1 szt.',
    );
    await appList.getByTestId('products-order').scrollIntoViewIfNeeded();
    await shot(app, '474-business-app-order');

    // Task 477: Barber Hurt's wax came — received from the phone.
    await appList.getByRole('button', { name: 'Przyjmij dostawę', exact: true }).click();
    const appDelivery = app.getByTestId('delivery');
    await expect(appDelivery.getByLabel('Przyszło — Wosk')).toHaveValue('4');
    await appDelivery.getByRole('button', { name: 'Barber Hurt' }).click();
    await expect(appDelivery.getByLabel('Przyszło — Szampon')).toHaveCount(0);
    await appDelivery.getByRole('button', { name: 'Przyjmij dostawę (4 szt.)' }).click();
    await expect(app.getByTestId('delivery-done')).toHaveText(
      'Dostawa przyjęta: 4 szt., produktów: 1.',
    );
    await expect(appList.getByTestId('products-to-order')).toHaveText(
      'Do zamówienia: Szampon (zostało 3 szt.)',
    );
    await app.getByTestId('delivery-done').scrollIntoViewIfNeeded();
    await shot(app, '477-business-app-delivery');
    await appContext.close();
  } finally {
    businessApp.server.close();
  }
});
