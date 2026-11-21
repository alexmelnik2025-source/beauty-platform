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
 * Task Q3 (part 2c): "Mój sklep" in the business app (web preview of apps/mobile-business). The
 * owner shows a pomade to clients on the phone, picks its card from the platform catalogue by the
 * EAN and switches "Sprzedawaj też w Sklepie" on; a wax is added already shown to clients.
 * Screenshots Q3-my-shop-app, Q3-my-shop-app-card.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `shop-app-owner-${run}@example.com`;
const OTHER = `shop-app-other-${run}@example.com`;
const EAN = `591${String(Date.now()).slice(-10)}`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

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

test('"Mój sklep" in the business app: shown to clients, a catalogue card, the Shop (task Q3)', async ({
  browser,
  request,
}) => {
  // Another salon made the card and sells it.
  const other = await salonOf(request, OTHER, `Inny Salon ${run}`);
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
      },
    }),
  );
  // Our salon: a pomade in the stock list only.
  const salon = await salonOf(request, OWNER, `Sklep App ${run}`);
  await json(
    await request.post(`${salon.base}/products`, {
      headers: salon.auth,
      data: { name: 'Pomada Reuzel różowa', priceGrosze: 5900, stockQuantity: 4 },
    }),
  );

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
    await app.getByRole('button', { name: 'Więcej', exact: true }).click();
    await app.getByRole('button', { name: 'Mój sklep' }).click();
    await expect(app.getByRole('heading', { name: 'Mój sklep' })).toBeVisible();
    await expect(app.getByText('Pokazane klientom: 0 z 1 produktów.')).toBeVisible();
    await expect(app.getByText('Pomada Reuzel różowa')).toBeVisible();
    await expect(app.getByText(/4 szt\./)).toBeVisible();

    await app.getByRole('button', { name: 'Pokaż klientom na stronie salonu' }).click();
    await expect(app.getByText('Pokazane klientom: 1 z 1 produktów.')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Ukryj ze strony salonu' })).toBeVisible();
    await expect(app.getByText(/wybierz kartę produktu z katalogu/)).toBeVisible();
    await shot(app, 'Q3-my-shop-app');

    // The card by its EAN — the other salon's one.
    await app.getByRole('button', { name: 'Wybierz z katalogu' }).click();
    await app.getByLabel('Nazwa, marka lub kod EAN').fill(EAN);
    await expect(app.getByText(/Reuzel Pink Pomade · Reuzel · EAN/)).toBeVisible();
    await expect(app.getByText(/liczba salonów: 1/)).toBeVisible();
    await shot(app, 'Q3-my-shop-app-card');
    await app.getByRole('button', { name: 'Wybierz kartę Reuzel Pink Pomade' }).click();
    await expect(app.getByText(/Karta w katalogu: Reuzel Pink Pomade/)).toBeVisible();
    await expect(app.getByText(/liczba salonów: 2/)).toBeVisible();

    // Now the Shop too.
    await app.getByRole('button', { name: 'Sprzedawaj też w Sklepie' }).click();
    await expect(app.getByRole('button', { name: 'Nie sprzedawaj w Sklepie' })).toBeVisible();

    // A wax, shown to clients at once.
    await app.getByLabel('Nazwa produktu').fill('Wosk matowy');
    await app.getByLabel(/Cena produktu/).fill('39,90');
    await app.getByLabel(/Sztuk w magazynie/).fill('10');
    await app.getByRole('button', { name: 'Dodaj produkt' }).click();
    await expect(app.getByText('Pokazane klientom: 2 z 2 produktów.')).toBeVisible();

    // What the "Sklep" tab answers.
    const shop = await json<{ products: { id: string; offers: { priceGrosze: number }[] }[] }>(
      await request.get('/v1/public/shop/products', { params: { q: EAN } }),
    );
    expect(shop.products.map((p) => p.id)).toEqual([card.id]);
    expect(shop.products[0]?.offers.map((o) => o.priceGrosze)).toEqual([5900]);
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
