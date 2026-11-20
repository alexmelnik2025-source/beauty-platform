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
 * Task Q3 (screen A): right after booking, the "booked" screen offers — folded and optional —
 * "Dodać coś do wizyty?" with at most three of the salon's products. The client opens it on the
 * phone and puts a pomade aside: it waits at the salon, paid at the visit. Screenshots
 * Q3-A-booked, Q3-A-booked-open.
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
});
