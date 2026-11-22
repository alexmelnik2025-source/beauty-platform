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
 * Part 2b: the shared card has no picture yet, so our salon adds one; it shows on the salon's
 * products but not in its gallery. Part 3: a client on the phone sees one folded row "Produkty
 * salonu (2)" under the services and opens it. Part 4b (screen B): on the visit link the client
 * puts the pomade aside with "Odbiorę przy wizycie" and gives it back. Screenshots Q3-my-shop,
 * Q3-my-shop-card, Q3-my-shop-photo, Q3-salon-products, Q3-visit-products.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const NAME = `Mój Sklep ${run}`;
const OWNER = `my-shop-${run}@example.com`;
const OTHER = `my-shop-other-${run}@example.com`;
const EAN = `590${String(Date.now()).slice(-10)}`;
const CLIENT = `my-shop-client-${run}@example.com`;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

/** A real picture drawn in the browser (the page shrinks it before sending). */
async function testPhoto(page: Page, width: number, height: number) {
  const base64 = await page.evaluate(
    ({ width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#e8a0bf';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#1d1d1b';
      ctx.font = `${Math.round(height / 6)}px sans-serif`;
      ctx.fillText('POMADE', width / 10, height / 2);
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    { width, height },
  );
  return { name: 'pomade.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

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
  // No way to switch shipping on at the launch — only the note that the client pays at the salon.
  await expect(page.getByRole('checkbox', { name: /wysyłk/i })).toHaveCount(0);
  // Task Q6: the explanations are under "?" next to the title; one main button "+ Dodaj produkt".
  await expect(page.getByText('bez płatności online i bez wysyłki')).toHaveCount(0);
  await page.getByRole('button', { name: 'Jak to działa?' }).click();
  await expect(page.getByText('bez płatności online i bez wysyłki')).toBeVisible();
  await page.getByRole('button', { name: 'Jak to działa?' }).click();
  // Task Q6: one row per product — status, stock, price; the switches open with the row.
  await expect(row.getByText('Ukryty')).toBeVisible();
  await expect(row.getByText('59,00 zł')).toBeVisible();
  await expect(row.getByLabel('Pokaż klientom na stronie salonu')).toHaveCount(0);
  await row.getByRole('button', { name: 'Szczegóły: Pomada Reuzel różowa' }).click();

  // Shown to clients on the salon page.
  await row.getByLabel('Pokaż klientom na stronie salonu').check();
  await expect(page.getByText('Pokazane klientom: 1 z 1 produktów.')).toBeVisible();
  const marketplace = row.getByLabel(/Sprzedawaj też w Sklepie/);
  await expect(marketplace).toBeDisabled();
  await expect(row.getByText(/wybierz kartę produktu z katalogu/)).toBeVisible();
  await expect(row.getByText('Na stronie salonu', { exact: true })).toBeVisible();
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
  await expect(row.getByText('W Sklepie', { exact: true })).toBeVisible();

  // Part 2b: the shared card has no picture yet — ours is the first.
  await row
    .getByLabel('Zdjęcie karty „Reuzel Pink Pomade”')
    .setInputFiles(await testPhoto(page, 900, 900));
  const picture = row.getByRole('img', { name: 'Zdjęcie: Reuzel Pink Pomade' });
  await expect(picture).toBeVisible();
  // Once the card has one and another salon sells it too, nobody changes it here.
  await expect(row.getByText('Zmień zdjęcie')).toHaveCount(0);
  await shot(page, 'Q3-my-shop-photo');

  // Quick add: a wax, shown to clients at once — the short form opens from "+ Dodaj produkt".
  await page.getByRole('button', { name: '+ Dodaj produkt' }).click();
  const addForm = page.locator('#shop-add');
  await addForm.getByLabel('Nazwa', { exact: true }).fill('Wosk matowy');
  await addForm.getByLabel('Cena', { exact: true }).fill('39,90');
  await addForm.getByLabel(/Sztuk w magazynie/).fill('10');
  await addForm.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page.getByText('Pokazane klientom: 2 z 2 produktów.')).toBeVisible();
  await expect(addForm).toHaveCount(0);
  await expect(page.getByText('Wosk matowy')).toBeVisible();

  // Task Q6: search and filters over the list, as in a shop admin.
  await row.getByRole('button', { name: 'Szczegóły: Pomada Reuzel różowa' }).click();
  const list = page.getByRole('list', { name: 'Mój sklep' });
  await page.getByRole('button', { name: /^W Sklepie/ }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Pomada Reuzel różowa');
  await page.getByRole('button', { name: /^Wszystkie/ }).click();
  await page.getByLabel('Szukaj produktu').fill('wosk');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Wosk matowy');
  await page.getByLabel('Szukaj produktu').fill('');
  await expect(list.getByRole('listitem')).toHaveCount(2);
  // Task 650: the search is the same field as the rest of the cabinet, not a bare browser box.
  const shopSearch = page.getByLabel('Szukaj produktu');
  await shopSearch.blur();
  expect((await shopSearch.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
  await shot(page, 'q6-shop-list');
  await page.setViewportSize({ width: 390, height: 844 });
  // The page keeps the cabinet's side margins on a phone — nothing touches the screen's edge.
  const titleBox = await page.locator('#my-shop-title').boundingBox();
  expect(titleBox?.x ?? 0).toBeGreaterThanOrEqual(12);
  await shot(page, 'q6-shop-list-phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  // What clients see.
  const salonProducts = await json<{
    fulfillment: string[];
    products: { name: string; priceGrosze: number; available: boolean; photoId: string | null }[];
  }>(await request.get(`/v1/public/locations/${salon.slug}/products`));
  expect(salonProducts.fulfillment).toEqual(['pickup_at_salon']);
  expect(salonProducts.products.map((p) => [p.name, p.priceGrosze, p.available])).toEqual([
    ['Pomada Reuzel różowa', 5900, true],
    ['Wosk matowy', 3990, true],
  ]);
  const photoId = salonProducts.products[0]?.photoId;
  expect(photoId).toBeTruthy();
  expect((await request.get(`/v1/public/photos/${photoId}`)).ok()).toBeTruthy();
  // Not a salon photo: the booking page's gallery stays empty.
  const salonPage = await json<{ photos: unknown[] }>(
    await request.get(`/v1/public/locations/${salon.slug}`),
  );
  expect(salonPage.photos).toEqual([]);
  const shop = await json<{
    products: { id: string; fromPriceGrosze: number; offers: { priceGrosze: number }[] }[];
  }>(await request.get('/v1/public/shop/products', { params: { q: EAN } }));
  expect(shop.products).toHaveLength(1);
  const [listed] = shop.products;
  expect(listed?.id).toBe(card.id);
  expect(listed?.fromPriceGrosze).toBe(5900);
  expect(listed?.offers.map((o) => o.priceGrosze)).toEqual([5900, 7900]);

  await desk.close();

  // Part 3: the client on the phone — one folded row, the services still first.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    locale: 'pl-PL',
  });
  try {
    const client = await phone.newPage();
    await client.goto(`/pl/b/${salon.slug}`);
    await expect(client.getByRole('heading', { name: NAME })).toBeVisible();
    const products = client.getByTestId('salon-products');
    const openRow = products.getByRole('button', { name: 'Produkty salonu (2)' });
    await expect(openRow).toBeVisible();
    await expect(openRow).toHaveAttribute('aria-expanded', 'false');
    await expect(client.getByText('Wosk matowy')).toHaveCount(0);
    await openRow.click();
    await expect(products.getByText('Odbiór i płatność w salonie, przy wizycie.')).toBeVisible();
    await expect(products.getByText('Pomada Reuzel różowa')).toBeVisible();
    await expect(products.getByText('59,00 zł')).toBeVisible();
    await expect(products.getByText('Wosk matowy')).toBeVisible();
    await expect(products.locator('img')).toHaveCount(1);
    await shot(client, 'Q3-salon-products');
    // The other salon shows one product; the row counts only what is shown to clients.
    await client.goto(`/pl/b/${other.slug}`);
    await expect(client.getByRole('heading', { name: `Inny Salon ${run}` })).toBeVisible();
    await expect(client.getByRole('button', { name: 'Produkty salonu (1)' })).toBeVisible();

    // Part 4b (screen B): a booked client puts the pomade aside by the visit link.
    const cut = await json<{ id: string }>(
      await request.post(`${salon.base}/services`, {
        headers: salon.auth,
        data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
      }),
    );
    const kasia = await json<{ id: string }>(
      await request.post(`${salon.base}/staff`, {
        headers: salon.auth,
        data: { displayName: 'Kasia', serviceIds: [cut.id] },
      }),
    );
    await json(
      await request.put(`${salon.base}/staff/${kasia.id}/working-hours`, {
        headers: salon.auth,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '08:00', end: '20:00' }],
          })),
        },
      }),
    );
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 2);
    start.setUTCHours(12, 0, 0, 0);
    const hold = await json<{ holdId: string; holdToken: string }>(
      await request.post(`/v1/public/locations/${salon.slug}/holds`, {
        data: { serviceId: cut.id, staffId: kasia.id, start: start.toISOString() },
      }),
    );
    await json(
      await request.post(`/v1/public/holds/${hold.holdId}/code`, {
        data: {
          holdToken: hold.holdToken,
          name: 'Anna Kowalska',
          phone: '+48 600 100 200',
          email: CLIENT,
          locale: 'pl',
          acceptTerms: true,
        },
      }),
    );
    const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
    const confirmed = await json<{ manageToken: string }>(
      await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
        data: { holdToken: hold.holdToken, code: /\b(\d{6})\b/.exec(codeMail.text)![1]! },
      }),
    );
    await client.goto(`/pl/m/${confirmed.manageToken}`);
    const section = client.getByTestId('visit-products');
    await expect(section.getByRole('heading', { name: 'Produkty do odbioru' })).toBeVisible();
    await section.getByRole('button', { name: '+ Dodaj produkt do tej wizyty' }).click();
    await section
      .getByRole('button', { name: 'Odbiorę przy wizycie: Pomada Reuzel różowa' })
      .click();
    await expect(section.getByText('Czeka w salonie — zapłacisz przy wizycie')).toBeVisible();
    await expect(
      section.getByText('Razem za produkty: 59,00 zł (płatność w salonie)'),
    ).toBeVisible();
    await shot(client, 'Q3-visit-products');
    // Only one piece of the wax? No — four pomades: a second one may still be put aside.
    await expect(
      section.getByRole('button', { name: 'Odbiorę przy wizycie: Pomada Reuzel różowa' }),
    ).toBeEnabled();
    // The client changes their mind.
    await section.getByRole('button', { name: 'Zrezygnuj: Pomada Reuzel różowa' }).click();
    await expect(section.getByText('Czeka w salonie — zapłacisz przy wizycie')).toHaveCount(0);
  } finally {
    await phone.close();
  }
});
