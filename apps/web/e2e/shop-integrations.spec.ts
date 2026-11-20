import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task Q4: "Integracje" in the cabinet. The owner connects Base (a stand-in on
 * BASE_API_URL — no real account or token), chooses the catalogue, ticks a product and imports it
 * (screenshots Q4-base-connect, Q4-base-pick, Q4-base-done), turns on orders to Base
 * (Q4-base-orders); then imports a CSV file
 * (Q4-feed). The page opens from "Usługi" → "Produkty".
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `integrations-owner-${run}@example.com`;
const TOKEN = '3001234-3005678-DEVONLYE2ETOKEN00000000';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

/** What the stand-in Base answers (see apps/api/test/shop-integrations.spec.ts for more). */
const FAKE_BASE: Record<string, object> = {
  getInventories: {
    inventories: [
      {
        inventory_id: 307,
        name: 'Sklep GESTALT',
        price_groups: [105],
        default_price_group: 105,
        warehouses: ['bl_201'],
        default_warehouse: 'bl_201',
      },
    ],
  },
  getInventoryPriceGroups: {
    price_groups: [{ price_group_id: 105, name: 'Detal', currency: 'PLN' }],
  },
  getInventoryWarehouses: {
    warehouses: [{ warehouse_type: 'bl', warehouse_id: 201, name: 'Magazyn Bema' }],
  },
  getInventoryProductsList: {
    products: {
      '9001': {
        id: 9001,
        ean: '0859104005020',
        sku: 'RZ-PINK',
        name: 'Reuzel Pink Pomade 113 g',
        prices: { '105': 69.99 },
        stock: { bl_201: 12 },
      },
      '9002': {
        id: 9002,
        ean: '5901234123457',
        sku: 'OIL-1',
        name: 'Olejek do brody Cedr',
        prices: { '105': 45.5 },
        stock: { bl_201: 3 },
      },
    },
  },
  getInventoryProductsData: {
    products: {
      '9001': {
        ean: '0859104005020',
        manufacturer_id: 12,
        text_fields: { name: 'Reuzel Pink Pomade 113 g', description: '<p>Mocne utrwalenie</p>' },
        prices: { '105': 69.99 },
        stock: { bl_201: 12 },
      },
    },
  },
  getInventoryManufacturers: { manufacturers: [{ manufacturer_id: 12, name: 'Reuzel' }] },
  getOrderStatusList: {
    statuses: [
      { id: 501, name: 'Nowe zamówienia' },
      { id: 502, name: 'Do odbioru w salonie' },
      { id: 503, name: 'Odebrane' },
      { id: 504, name: 'Anulowane' },
    ],
  },
};

let fakeBase: Server;

test.beforeAll(async () => {
  const port = Number(new URL(process.env.BASE_API_URL ?? 'http://127.0.0.1:4790/').port);
  fakeBase = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const method = new URLSearchParams(body).get('method') ?? '';
      const ok = req.headers['x-bltoken'] === TOKEN;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          ok && FAKE_BASE[method]
            ? { status: 'SUCCESS', ...FAKE_BASE[method] }
            : { status: 'ERROR', error_code: ok ? 'ERROR_UNKNOWN_METHOD' : 'ERROR_BAD_TOKEN' },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => fakeBase.listen(port, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => fakeBase.close(resolve));
});

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function ownerWithSalon(api: APIRequestContext) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name: 'GESTALT' } }),
  );
  await json(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name: 'Gestalt Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
}

test('the owner imports products from Base and from a CSV file', async ({ browser, request }) => {
  await ownerWithSalon(request);
  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    extraHTTPHeaders: freshAddress(),
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);

  // From "Usługi" → "Produkty".
  await page.goto('/pl/app/services');
  await page.getByTestId('products-integrations').click();
  await page.waitForURL(/\/pl\/app\/shop\/integrations/);
  await expect(page.getByRole('heading', { name: 'Integracje' })).toBeVisible();

  // Step 1: a wrong token is refused in plain words; the right one connects.
  const baseCard = page.getByTestId('integration-base');
  await baseCard.getByLabel('Token API z Base').fill('wrong-token-0000000000000000');
  await baseCard.getByRole('button', { name: 'Połącz' }).click();
  await expect(page.getByText('Base nie przyjął tego tokenu.', { exact: false })).toBeVisible();
  await baseCard.getByLabel('Token API z Base').fill(TOKEN);
  await shot(page, 'Q4-base-connect');
  await baseCard.getByRole('button', { name: 'Połącz' }).click();

  // Step 2: the catalogue, price group and warehouse are already suggested.
  await expect(baseCard.getByLabel('Katalog')).toHaveValue('307');
  await expect(baseCard.getByLabel('Magazyn')).toHaveValue('bl_201');
  await baseCard.getByRole('button', { name: 'Zapisz' }).click();
  await expect(baseCard.getByText('Połączono (token …0000)', { exact: false })).toBeVisible();

  // Step 3: tick the pomade, also online, and import it.
  await baseCard.getByRole('button', { name: 'Wybierz produkty' }).click();
  const picker = baseCard.getByTestId('integration-picker');
  await expect(picker.getByText('Olejek do brody Cedr')).toBeVisible();
  await picker.getByRole('checkbox', { name: /Reuzel Pink Pomade/ }).check();
  await picker.getByRole('checkbox', { name: 'też online w Sklepie' }).check();
  await shot(page, 'Q4-base-pick');
  await picker.getByRole('button', { name: 'Importuj zaznaczone (1)' }).click();
  await expect(
    baseCard.getByText('Gotowe: nowych 1, zaktualizowanych 0, pominiętych 0.'),
  ).toBeVisible();
  await expect(baseCard.getByText('z Base: 1 prod.', { exact: false })).toBeVisible();
  await baseCard.getByText('Dziennik synchronizacji').click();
  await shot(page, 'Q4-base-done');

  // Task Q4 (part 5): products put aside for a visit go to Base as orders, in chosen statuses.
  const orders = baseCard.getByTestId('integration-base-orders');
  await orders.getByText('Zamówienia do Base: Wyłączone.').click();
  await orders.getByLabel('Wysyłaj rezerwacje do Base jako zamówienia').check();
  await orders
    .getByLabel('Status nowego zamówienia')
    .selectOption({ label: 'Do odbioru w salonie' });
  await orders.getByLabel('Po wydaniu produktu').selectOption({ label: 'Odebrane' });
  await orders.getByLabel('Gdy rezerwacja przepadnie').selectOption({ label: 'Anulowane' });
  await shot(page, 'Q4-base-orders');
  await orders.getByRole('button', { name: 'Zapisz' }).click();
  await expect(orders.getByText('Zamówienia do Base: Włączone', { exact: false })).toBeVisible();

  // A file instead of Base: a CSV from Excel, on the phone.
  await page.setViewportSize(PHONE);
  const feedCard = page.getByTestId('integration-feed');
  await feedCard.scrollIntoViewIfNeeded();
  await feedCard.getByLabel('Plik CSV lub XML').setInputFiles({
    name: 'produkty.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Symbol;Nazwa;EAN;Cena;Stan\nGR-1;Grzebień do brody;;12,00;10\nWAX-1;Wosk matowy;;39,00;4\n',
    ),
  });
  const filePicker = feedCard.getByTestId('integration-picker');
  await expect(filePicker.getByText('Grzebień do brody')).toBeVisible();
  await filePicker.getByRole('button', { name: 'Zaznacz wszystkie z ceną' }).click();
  await shot(page, 'Q4-feed');
  await filePicker.getByRole('button', { name: 'Importuj zaznaczone (2)' }).click();
  await expect(
    feedCard.getByText('Gotowe: nowych 2, zaktualizowanych 0, pominiętych 0.'),
  ).toBeVisible();

  // The imported products are the salon's own now.
  await page.setViewportSize(DESKTOP);
  await page.goto('/pl/app/services');
  const products = page.getByTestId('products');
  await expect(products.getByLabel('Nazwa — Reuzel Pink Pomade 113 g')).toBeVisible();
  await expect(products.getByLabel('Nazwa — Wosk matowy')).toBeVisible();
  await expect(products.getByLabel('W magazynie — Reuzel Pink Pomade 113 g')).toHaveValue('12');
  await context.close();
});
