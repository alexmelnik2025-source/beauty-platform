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
 * Task Q3 (screen A): right after booking, the "booked" screen offers — folded and optional —
 * "Dodać coś do wizyty?" with at most three of the salon's products. The client opens it on the
 * phone and puts a pomade aside: it waits at the salon, paid at the visit. Screenshots
 * Q3-A-booked, Q3-A-booked-open. Then "Moje wizyty" in the client app shows the same products in
 * the visit card: the client gives the pomade back and puts another product aside (Q3-B-app).
 * Last, in "Sklep" a product of the same salon offers "Odbiorę przy wizycie · <date>" for that
 * visit (Q3-app-shop-reserve).
 * (Named "shop-…" so it runs after booking.spec.ts, which counts the salons in the catalogue.)
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `booked-products-${run}@example.com`;
const CLIENT = `booked-products-client-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function owner(api: APIRequestContext) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Właściciel' },
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
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const name = `Dodaj Do Wizyty ${run}`;
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name } }),
  );
  const location = await json<{ id: string; slug: string }>(
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
  return {
    auth,
    base: `/v1/organizations/${org.id}/locations/${location.id}`,
    slug: location.slug,
  };
}

test('"Dodać coś do wizyty?" on the booked screen (task Q3, screen A)', async ({
  browser,
  request,
}) => {
  const salon = await owner(request);
  for (const [name, priceGrosze] of [
    ['Pomada Reuzel różowa', 5900],
    ['Wosk matowy', 4500],
    ['Szampon Proraso', 3900],
    ['Olejek do brody', 4900],
  ] as const) {
    await json(
      await request.post(`${salon.base}/products`, {
        headers: salon.auth,
        data: { name, priceGrosze, stockQuantity: 5, inSalonShop: true },
      }),
    );
  }
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

  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    extraHTTPHeaders: freshAddress(),
  });
  const client = await context.newPage();
  await client.goto(`/pl/b/${salon.slug}`);
  await client
    .getByRole('button', { name: /Strzyżenie/ })
    .first()
    .click();
  const times = client.locator('.times button').first();
  const kasiaButton = client.getByRole('button', { name: /Kasia/ });
  await expect(times.or(kasiaButton).first()).toBeVisible();
  if (await kasiaButton.isVisible()) await kasiaButton.click();
  await times.click();
  await client.getByLabel('Imię i nazwisko').fill('Anna Kowalska');
  await client.getByLabel('Telefon').fill('600 100 202');
  await client.getByLabel('E-mail').fill(CLIENT);
  await client.getByLabel(/Akceptuję regulamin rezerwacji/).check();
  await client.getByRole('button', { name: 'Wyślij kod' }).click();
  const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
  await client.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(codeMail.text)![1]!);
  await client.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(client.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();

  // Folded: only the question and one quiet button until the client opens it.
  const offer = client.getByTestId('booked-products');
  await expect(offer.getByRole('heading', { name: 'Dodać coś do wizyty?' })).toBeVisible();
  await expect(offer.getByRole('button', { name: /^Odbiorę przy wizycie/ })).toHaveCount(0);
  await offer.scrollIntoViewIfNeeded();
  await shot(client, 'Q3-A-booked');

  await offer.getByRole('button', { name: '+ Dodaj produkt do tej wizyty' }).click();
  await expect(offer.getByRole('button', { name: /^Odbiorę przy wizycie/ })).toHaveCount(3);
  await offer
    .getByRole('button', { name: /^Odbiorę przy wizycie/ })
    .first()
    .click();
  await expect(offer.getByText('Czeka w salonie — zapłacisz przy wizycie')).toBeVisible();
  await expect(offer.getByText(/Razem za produkty: .* \(płatność w salonie\)/)).toBeVisible();
  await shot(client, 'Q3-A-booked-open');
  await context.close();

  // The client app: the visit card shows what waits at the salon.
  const clientApp = await serveApp('mobile-client');
  try {
    const phone = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByLabel('E-mail', { exact: true }).fill(CLIENT);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const signIn = await waitForEmail(CLIENT, /Kod logowania do Twoich wizyt/);
    await app.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(signIn.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await app
      .getByRole('button', { name: /Strzyżenie, Dodaj Do Wizyty/ })
      .first()
      .click();
    const card = app.getByRole('region', { name: 'Produkty do odbioru' });
    await expect(card.getByText('Czeka w salonie — zapłacisz przy wizycie')).toBeVisible();
    await card.getByRole('button', { name: /^Zrezygnuj: / }).click();
    await expect(card.getByText('Czeka w salonie — zapłacisz przy wizycie')).toHaveCount(0);
    const addToggle = card.getByRole('button', { name: '+ Dodaj produkt do tej wizyty' });
    await expect(addToggle).toHaveAttribute('aria-expanded', 'false');
    await addToggle.click();
    await expect(addToggle).toHaveAttribute('aria-expanded', 'true');
    await card.getByRole('button', { name: 'Odbiorę przy wizycie: Wosk matowy' }).click();
    await expect(card.getByText('Czeka w salonie — zapłacisz przy wizycie')).toBeVisible();
    await expect(
      card.getByText(/Razem za produkty: 45,00\s*zł \(płatność w salonie\)/),
    ).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await shot(app, 'Q3-B-app');

    // "Sklep": a product of this salon offers "Odbiorę przy wizycie · <date>" — the client has a
    // visit there, so one tap puts it aside for that visit (Q3-app-shop-reserve).
    const balm = `Balsam do brody ${run}`;
    const card2 = await json<{ id: string }>(
      await request.post(`${salon.base}/shop/catalog`, {
        headers: salon.auth,
        data: { name: balm, brand: 'Gestalt', category: 'beard' },
      }),
    );
    await json(
      await request.post(`${salon.base}/products`, {
        headers: salon.auth,
        data: {
          name: balm,
          priceGrosze: 5500,
          stockQuantity: 3,
          catalogProductId: card2.id,
          inSalonShop: true,
          inMarketplace: true,
        },
      }),
    );
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await app.getByRole('button', { name: /Sklep — kosmetyki z salonów/ }).click();
    await app.getByLabel('Szukaj produktu lub marki').fill(balm);
    await app.getByRole('button', { name: new RegExp(balm) }).click();
    await expect(app.getByRole('heading', { name: balm })).toBeVisible();
    const reserve = app.getByRole('button', {
      name: new RegExp(`^Odbiorę przy wizycie · .+: Dodaj Do Wizyty ${run}$`),
    });
    await expect(reserve).toBeVisible();
    await reserve.click();
    await expect(app.getByText(/^Odłożone na wizytę .+ Płacisz w salonie\./)).toBeVisible();
    await expect(reserve).toHaveCount(0);
    await shot(app, 'Q3-app-shop-reserve');
    await phone.close();
  } finally {
    clientApp.server.close();
  }
});
