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
 * Task 254: the order and names of the price-list categories. The owner has "Włosy" and
 * "Broda"; in "Usługi" "↑" by "Broda" puts it first (the order clients see on the booking
 * page), "Zmień nazwę" turns it into "Broda i golenie", and a new category "Dzieci" goes to
 * the end. Screenshot 254.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `category-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

interface Category {
  id: string;
  name: string;
}

async function salon(api: APIRequestContext) {
  const address = freshAddress();
  await json(
    await api.post('/v1/auth/register', {
      headers: address,
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
      headers: address,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: 'Kategorie Barber' } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Kategorie Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const categories: Record<string, string> = {};
  for (const name of ['Włosy', 'Broda']) {
    const category = await json<{ id: string }>(
      await api.post(`${base}/service-categories`, { headers: owner, data: { name } }),
    );
    categories[name] = category.id;
  }
  for (const [name, category] of [
    ['Strzyżenie męskie', 'Włosy'],
    ['Trymowanie brody', 'Broda'],
  ] as const) {
    await json(
      await api.post(`${base}/services`, {
        headers: owner,
        data: { name, durationMinutes: 30, priceGrosze: 6000, categoryId: categories[category] },
      }),
    );
  }
  return { owner, base, address };
}

test('the owner orders and renames the categories of the price list', async ({
  browser,
  request,
}) => {
  const { owner, base, address } = await salon(request);
  const categories = async () =>
    (
      await json<Category[]>(await request.get(`${base}/service-categories`, { headers: owner }))
    ).map((c) => c.name);

  const desk = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: address,
  });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\//);
  await cabinet.goto('/pl/app/services');

  const headings = cabinet.locator('.section h2');
  await expect(headings).toHaveText(['Włosy', 'Broda']);
  await expect(cabinet.getByRole('button', { name: 'Wyżej: Włosy' })).toBeDisabled();
  await cabinet.getByRole('button', { name: 'Wyżej: Broda' }).click();
  await expect(cabinet.getByRole('button', { name: 'Wyżej: Broda' })).toBeDisabled();
  await expect(headings).toHaveText(['Broda', 'Włosy']);
  expect(await categories()).toEqual(['Broda', 'Włosy']);

  // Rename "Broda" in place.
  await cabinet.getByRole('button', { name: 'Zmień nazwę' }).first().click();
  const name = cabinet.getByLabel('Nazwa kategorii', { exact: true }).first();
  await expect(name).toHaveValue('Broda');
  await name.fill('Broda i golenie');
  await cabinet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(headings).toHaveText(['Broda i golenie', 'Włosy']);

  // A new category goes to the end of the order the owner set.
  await cabinet.getByPlaceholder('Nazwa kategorii').fill('Dzieci');
  await cabinet.getByRole('button', { name: 'Nowa kategoria' }).click();
  await expect(headings).toHaveText(['Broda i golenie', 'Włosy', 'Dzieci']);
  await shot(cabinet, '254-category-order');
  expect(await categories()).toEqual(['Broda i golenie', 'Włosy', 'Dzieci']);
  await desk.close();
});
