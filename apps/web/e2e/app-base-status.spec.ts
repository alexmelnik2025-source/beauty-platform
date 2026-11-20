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
import { serveApp } from './mobile-app';

/**
 * Task Q4: Base on the phone — the "Base" card of "Mój sklep" in the business app (web preview of
 * apps/mobile-business). Without Base the owner sees one quiet line pointing to the cabinet; after
 * Base is connected and a product imported (as in the cabinet, here through the API, against a
 * stand-in Base on BASE_API_URL — no real account or token) the card shows the products from Base
 * and the last renewal, and "Synchronizuj teraz" says what it did. Screenshot Q4-base-app.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `base-app-owner-${run}@example.com`;
const TOKEN = '3001234-3005678-DEVONLYE2ETOKEN00000000';
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
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonOf(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name: 'Właściciel' },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${name}.`,
      },
    }),
  );
  return { auth, base: `/v1/organizations/${org.id}/locations/${location.id}` };
}

/** The business app's sign-in: email → code from Mailpit → the day calendar. */
async function signInToApp(app: Page, url: string, email: string) {
  await app.goto(url);
  await app.getByLabel('E-mail lub telefon').fill(email);
  await app.getByRole('button', { name: 'Wyślij kod' }).click();
  const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
  await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
  await app.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
}

test('"Base" in "Mój sklep" of the business app: status and "Synchronizuj teraz" (task Q4)', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const salon = await salonOf(request, OWNER, `Base App ${run}`);
  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await context.newPage();
    await signInToApp(app, businessApp.url, OWNER);

    // No Base yet: one quiet line, no card and no button.
    await app.getByRole('button', { name: 'Mój sklep' }).click();
    await expect(app.getByRole('heading', { name: 'Mój sklep' })).toBeVisible();
    await expect(app.getByText(/podłączysz w panelu na komputerze/)).toBeVisible();
    await expect(app.getByRole('button', { name: 'Synchronizuj teraz' })).toHaveCount(0);
    await app.getByRole('button', { name: '‹ Wróć' }).click();

    // Base is connected in the cabinet: token → catalogue, price group, warehouse → one product.
    await json(
      await request.put(`${salon.base}/shop/integrations/base`, {
        headers: salon.auth,
        data: { token: TOKEN },
      }),
    );
    await json(
      await request.patch(`${salon.base}/shop/integrations/base`, {
        headers: salon.auth,
        data: { inventoryId: '307', priceGroupId: '105', warehouseId: 'bl_201' },
      }),
    );
    await json(
      await request.post(`${salon.base}/shop/integrations/base/import`, {
        headers: salon.auth,
        data: { items: [{ externalId: '9001', online: false }] },
      }),
    );

    await app.getByRole('button', { name: 'Mój sklep' }).click();
    await expect(app.getByText(/Połączono z Base \(…0000\) · produktów z Base: 1/)).toBeVisible();
    await expect(
      app.getByText(/Ostatnia synchronizacja: (przed chwilą|\d+ min temu)\./),
    ).toBeVisible();
    await expect(app.getByText('Ceny i stany odświeżamy co 60 min.')).toBeVisible();
    await expect(app.getByText('Reuzel Pink Pomade 113 g', { exact: true })).toBeVisible();

    await app.getByRole('button', { name: 'Synchronizuj teraz' }).click();
    // The regular renewal (every 5 min on the server) may have just run: then wait the minute.
    await expect(app.getByText(/Sprawdzono: 1|spróbuj za minutę/)).toBeVisible();
    if (await app.getByText(/spróbuj za minutę/).isVisible()) {
      await app.waitForTimeout(61_000);
      await app.getByRole('button', { name: 'Synchronizuj teraz' }).click();
    }
    await expect(app.getByText(/^Sprawdzono: 1 · zmieniono: \d+$/)).toBeVisible();
    await shot(app, 'Q4-base-app');

    // Again at once: the API asks to wait a minute, said in plain words.
    await app.getByRole('button', { name: 'Synchronizuj teraz' }).click();
    await expect(app.getByText(/spróbuj za minutę/)).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
