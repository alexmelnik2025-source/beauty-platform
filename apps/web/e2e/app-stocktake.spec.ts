import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const PASSWORD = 'e2e-password-123';
const ADDRESS = freshAddress();
const OWNER = `app-stocktake-owner-${Date.now().toString(36)}@example.com`;

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: ADDRESS,
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
      headers: ADDRESS,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app saves counted stock and shows the differences', async ({ browser, request }) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Stocktake Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  for (const [name, stockQuantity] of [
    ['Pomada', 8],
    ['Szampon', 3],
    ['Olejek', 6],
  ] as const) {
    await json(
      await request.post(`${base}/products`, {
        headers: owner,
        data: { name, stockQuantity, priceGrosze: 5900 },
      }),
    );
  }

  const app = await serveApp('mobile-business');
  const context = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: ADDRESS,
  });
  try {
    const phone = await context.newPage();
    await phone.goto(app.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();

    await phone.getByRole('tab', { name: 'Sklep', exact: true }).click();
    await phone.getByRole('button', { name: 'Magazyn ▸', exact: true }).click();
    const openStocktake = phone.getByRole('button', { name: 'Inwentaryzacja', exact: true });
    await openStocktake.click();
    const stocktake = phone.getByTestId('stocktake');
    const pomade = stocktake.getByLabel('Na półce — Pomada');
    const shampoo = stocktake.getByLabel('Na półce — Szampon');
    const oil = stocktake.getByLabel('Na półce — Olejek');
    const save = stocktake.getByRole('button', { name: 'Zapisz inwentaryzację' });
    await expect(pomade).toHaveValue('8');
    await expect(shampoo).toHaveValue('3');
    await expect(oil).toHaveValue('6');
    await expect(save).toBeDisabled();

    await pomade.fill('-1');
    await expect(stocktake.getByText('Wpisz liczbę sztuk albo zostaw puste.')).toBeVisible();
    await expect(save).toBeDisabled();

    await pomade.fill('5');
    await expect(stocktake.getByText('Wpisz liczbę sztuk albo zostaw puste.')).toBeHidden();
    await shampoo.fill('7');
    await oil.clear();
    await expect(stocktake.getByText('w systemie: 8 szt. · brakuje 3 szt.')).toBeVisible();
    await expect(stocktake.getByText('w systemie: 3 szt. · nadwyżka 4 szt.')).toBeVisible();
    await save.click();
    await expect(phone.getByTestId('stocktake-done')).toHaveText(
      'Inwentaryzacja zapisana: zmienione produkty: 2, brakuje 3 szt., nadwyżka 4 szt.',
    );
    await expect(stocktake).toBeHidden();

    const saved = await json<{ products: { name: string; stockQuantity: number }[] }>(
      await request.get(`${base}/products`, { headers: owner }),
    );
    expect(
      Object.fromEntries(saved.products.map(({ name, stockQuantity }) => [name, stockQuantity])),
    ).toEqual({ Pomada: 5, Szampon: 7, Olejek: 6 });
    await openStocktake.click();
    await expect(pomade).toHaveValue('5');
    await expect(shampoo).toHaveValue('7');
    await expect(oil).toHaveValue('6');
    await expect(save).toBeDisabled();
  } finally {
    await context.close();
    app.server.close();
  }
});
