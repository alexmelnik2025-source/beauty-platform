import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task Q3 (part 2a): "Mój sklep" in the cabinet. The owner shows a pomade to clients on the salon
 * page, picks its card from the platform catalogue (made by another salon, found by the EAN) and
 * switches "Sprzedawaj też w Sklepie" on; a quick "Dodaj produkt" adds a wax already shown to
 * clients. The public salon page's products and the "Sklep" tab answer accordingly.
 * Screenshots Q3-my-shop, Q3-my-shop-card.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const NAME = `Mój Sklep ${run}`;
const OWNER = `my-shop-${run}@example.com`;
const OTHER = `my-shop-other-${run}@example.com`;
const EAN = `590${String(Date.now()).slice(-10)}`;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function ownerOf(api: APIRequestContext, email: string, salonName: string) {
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
    await api.post('/v1/organizations', { headers: auth, data: { name: salonName } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name: salonName,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${salonName}.`,
      },
    }),
  );
  return {
    auth,
    base: `/v1/organizations/${org.id}/locations/${location.id}`,
    slug: location.slug,
  };
}

test('"Mój sklep": a product shown to clients, its catalogue card and the "Sklep" tab (task Q3)', async ({
  browser,
  request,
}) => {
  // Another salon already made the pomade's card and sells it.
  const other = await ownerOf(request, OTHER, `Inny Salon ${run}`);
  const card = await json<{ id: string }>(
    await request.post(`${other.base}/shop/catalog`, {
      headers: other.auth,
      data: { name: 'Reuzel Pink Pomade', brand: 'Reuzel', ean: EAN, category: 'styling' },
    }),
  );
  await json(
    await request.post(`${other.base}/products`, {
      headers: other.auth,
      data: {
        name: 'Reuzel Pink',
        priceGrosze: 7900,
        catalogProductId: card.id,
        inSalonShop: true,
        inMarketplace: true,
      },
    }),
  );

  // Our salon: a pomade in the stock list only.
  const salon = await ownerOf(request, OWNER, NAME);
  const pomade = await json<{ id: string }>(
    await request.post(`${salon.base}/products`, {
      headers: salon.auth,
      data: { name: 'Pomada Reuzel różowa', priceGrosze: 5900, stockQuantity: 4 },
    }),
  );

  const desk = await browser.newContext({ locale: 'pl-PL', extraHTTPHeaders: freshAddress() });
  const page = await desk.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page).toHaveURL(/\/pl\/app/);

  await page.goto('/pl/app/shop');
  await expect(page.getByRole('heading', { name: 'Mój sklep' })).toBeVisible();
  await expect(page.getByText('Pokazane klientom: 0 z 1 produktów.')).toBeVisible();
  const row = page.getByTestId(`shop-product-${pomade.id}`);
  await expect(row.getByText('Pomada Reuzel różowa')).toBeVisible();
  await expect(row.getByText('4 szt.')).toBeVisible();
  // Nothing about shipping at the launch.
  await expect(page.getByText(/wysyłk/i)).toHaveCount(0);

  // Shown to clients on the salon page.
  await row.getByLabel('Pokaż klientom na stronie salonu').check();
  await expect(page.getByText('Pokazane klientom: 1 z 1 produktów.')).toBeVisible();
  const marketplace = row.getByLabel(/Sprzedawaj też w Sklepie/);
  await expect(marketplace).toBeDisabled();
  await expect(row.getByText(/wybierz kartę produktu z katalogu/)).toBeVisible();
  await shot(page, 'Q3-my-shop');

  // The card: found in the catalogue by the EAN, the other salon's one.
  await row.getByRole('button', { name: 'Wybierz z katalogu' }).click();
  await row.getByLabel('Nazwa, marka lub kod EAN').fill(EAN);
  const foundCard = row.getByRole('list', { name: 'Znalezione karty' }).getByRole('listitem');
  await expect(foundCard).toHaveCount(1);
  await expect(foundCard).toContainText('Reuzel Pink Pomade · Reuzel');
  await expect(foundCard).toContainText('liczba salonów: 1');
  await shot(page, 'Q3-my-shop-card');
  await foundCard.getByRole('button', { name: 'Wybierz' }).click();
  await expect(row.getByText('Karta w katalogu:')).toBeVisible();
  await expect(row.getByText('Reuzel Pink Pomade')).toBeVisible();
  await expect(row.getByText('liczba salonów: 2')).toBeVisible();

  // Now the "Sklep" tab too.
  await expect(marketplace).toBeEnabled();
  await marketplace.check();
  await expect(marketplace).toBeChecked();

  // Quick add: a wax, shown to clients at once.
  await page.getByLabel('Nazwa', { exact: true }).fill('Wosk matowy');
  await page.getByLabel('Cena', { exact: true }).fill('39,90');
  await page.getByLabel(/Sztuk w magazynie/).fill('10');
  await page.getByRole('button', { name: 'Dodaj produkt' }).click();
  await expect(page.getByText('Pokazane klientom: 2 z 2 produktów.')).toBeVisible();
  await expect(page.getByText('Wosk matowy')).toBeVisible();

  // What clients see.
  const salonProducts = await json<{
    fulfillment: string[];
    products: { name: string; priceGrosze: number; available: boolean }[];
  }>(await request.get(`/v1/public/locations/${salon.slug}/products`));
  expect(salonProducts.fulfillment).toEqual(['pickup_at_salon']);
  expect(salonProducts.products.map((p) => [p.name, p.priceGrosze, p.available])).toEqual([
    ['Pomada Reuzel różowa', 5900, true],
    ['Wosk matowy', 3990, true],
  ]);
  const shop = await json<{
    products: { id: string; fromPriceGrosze: number; offers: { priceGrosze: number }[] }[];
  }>(await request.get('/v1/public/shop/products', { params: { q: EAN } }));
  expect(shop.products).toHaveLength(1);
  const [listed] = shop.products;
  expect(listed?.id).toBe(card.id);
  expect(listed?.fromPriceGrosze).toBe(5900);
  expect(listed?.offers.map((o) => o.priceGrosze)).toEqual([5900, 7900]);

  await desk.close();
});
