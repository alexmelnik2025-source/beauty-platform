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
 * Task Q3 (screen 2): "Sklep" in the client app (web preview of apps/mobile-client). A quiet link
 * under "Znajdź salon" opens the products salons sell online; the search finds one, its page
 * shows the salon, the price and "Odbiór w salonie, płatność na miejscu" (no shipping, no online
 * payment at the launch), and "Umów wizytę" opens that salon. Screenshots Q3-app-shop,
 * Q3-app-shop-product. (The file name keeps it after booking.spec.ts, which counts the salons.)
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Sklep Salonu ${run}`;
const OWNER = `app-shop-${run}@example.com`;
const PRODUCT = `Pasta matowa ${run}`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function onlineSalon(api: APIRequestContext): Promise<{ slug: string }> {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: NAME,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const card = await json<{ id: string }>(
    await api.post(`${base}/shop/catalog`, {
      headers: owner,
      data: {
        name: PRODUCT,
        brand: 'Gestalt',
        category: 'styling',
        description: 'Mocne utrwalenie, matowe wykończenie. Zmywa się wodą.',
      },
    }),
  );
  await json(
    await api.post(`${base}/products`, {
      headers: owner,
      data: {
        name: PRODUCT,
        priceGrosze: 4900,
        stockQuantity: 5,
        catalogProductId: card.id,
        inSalonShop: true,
        inMarketplace: true,
      },
    }),
  );
  return { slug: location.slug };
}

test('"Sklep" in the client app lists products from salons, picked up at the salon (task Q3)', async ({
  browser,
  request,
}) => {
  const { slug } = await onlineSalon(request);
  const phone = await browser.newContext({ viewport: PHONE, isMobile: true, locale: 'pl-PL' });
  const clientApp = await serveApp('mobile-client');
  try {
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByRole('button', { name: /Sklep — kosmetyki z salonów/ }).click();
    await expect(app.getByRole('heading', { name: 'Sklep' })).toBeVisible();
    await app.getByLabel('Szukaj produktu lub marki').fill(PRODUCT);
    const item = app.getByRole('button', { name: new RegExp(PRODUCT) });
    await expect(item).toBeVisible();
    await expect(item).toContainText('od 49,00');
    await expect(item).toContainText(NAME);
    await shot(app, 'Q3-app-shop');

    // The older search response cannot replace the newest category results.
    const search = app.getByLabel('Szukaj produktu lub marki');
    const prefix = PRODUCT.slice(0, -1);
    const staleSearch = (url: string) => {
      const params = new URL(url).searchParams;
      return params.get('q') === prefix && !params.has('category');
    };
    let releaseSearch!: () => void;
    const olderResult = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    await app.route('**/v1/public/shop/products?*', async (route) => {
      if (!staleSearch(route.request().url())) return route.continue();
      const response = await route.fetch();
      await olderResult;
      await route.fulfill({ response });
    });
    const requested = app.waitForRequest((request) => staleSearch(request.url()));
    await search.fill(prefix);
    await requested;
    try {
      const cancelled = app.waitForEvent('requestfailed', (request) => staleSearch(request.url()));
      await app.getByRole('button', { name: 'Broda', exact: true }).click();
      const empty = app.getByText('Nic nie znaleziono. Zmień wyszukiwanie.');
      await expect(empty).toBeVisible();
      releaseSearch();
      expect((await cancelled).failure()?.errorText).toContain('ERR_ABORTED');
      await app.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(empty).toBeVisible();
      await expect(item).toHaveCount(0);
    } finally {
      releaseSearch();
    }
    await search.fill(PRODUCT);
    await app.getByRole('button', { name: 'Wszystko', exact: true }).click();
    await item.click();

    await expect(app.getByRole('heading', { name: PRODUCT })).toBeVisible();
    await expect(app.getByText('Odbiór w salonie, płatność na miejscu.')).toBeVisible();
    await expect(app.getByText(/wysyłk|dostaw/i)).toHaveCount(0);
    await expect(app.getByText('ul. Józefa Bema 91, Warszawa')).toBeVisible();
    await shot(app, 'Q3-app-shop-product');

    // "Umów wizytę" opens that salon; back returns to the shop, the search kept.
    await app.getByRole('button', { name: `Umów wizytę: ${NAME}` }).click();
    await expect(app.getByRole('heading', { name: NAME })).toBeVisible();
    expect(slug).toBeTruthy();
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await expect(app.getByRole('heading', { name: PRODUCT })).toBeVisible();
    // Without a visit at that salon: "Zapisz się i odbierz" (the product is put aside after booking).
    await expect(app.getByRole('button', { name: `Zapisz się i odbierz: ${NAME}` })).toBeVisible();
  } finally {
    await phone.close();
    clientApp.server.close();
  }
});
