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
 * Task 254: the order and names of the price-list categories. The owner has "Broda" and
 * "Włosy"; in "Usługi" "↑" by "Włosy" puts it first (the order clients see on the booking
 * page), "Zmień nazwę" turns "Broda" into "Broda i golenie", and a new category "Dzieci" goes
 * to the end. Screenshot 254. Task 700: an empty name is said under the field (screenshot 700).
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
  // Both were added without a place: the server lists them by name.
  await expect(headings).toHaveText(['Broda', 'Włosy']);
  await expect(cabinet.getByRole('button', { name: 'Wyżej: Broda' })).toBeDisabled();
  await cabinet.getByRole('button', { name: 'Wyżej: Włosy' }).click();
  await expect(cabinet.getByRole('button', { name: 'Wyżej: Włosy' })).toBeDisabled();
  await expect(headings).toHaveText(['Włosy', 'Broda']);
  await expect.poll(categories).toEqual(['Włosy', 'Broda']);

  // Rename "Broda" in place.
  await cabinet.getByRole('button', { name: 'Zmień nazwę' }).nth(1).click();
  const name = cabinet.getByLabel('Nazwa kategorii', { exact: true }).first();
  await expect(name).toHaveValue('Broda');
  // Task 700: an empty name is said under the field, not in the browser's bubble.
  await name.fill('  ');
  await cabinet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(cabinet.locator('#category-rename-error')).toHaveText('Uzupełnij to pole.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();
  await name.fill('Broda i golenie');
  await expect(cabinet.locator('#category-rename-error')).toHaveCount(0);
  await cabinet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(headings).toHaveText(['Włosy', 'Broda i golenie']);

  // Task 700: "Nowa kategoria" without a name — said under the field, the cursor goes there.
  await cabinet.getByRole('button', { name: 'Nowa kategoria' }).click();
  const added = cabinet.getByPlaceholder('Nazwa kategorii');
  await expect(cabinet.locator('#category-add-error')).toHaveText('Uzupełnij to pole.');
  await expect(added).toHaveAttribute('aria-invalid', 'true');
  await expect(added).toBeFocused();
  await shot(cabinet, '700-category-name-error');
  await expect.poll(categories).toEqual(['Włosy', 'Broda i golenie']);

  // A new category goes to the end of the order the owner set.
  await cabinet.getByPlaceholder('Nazwa kategorii').fill('Dzieci');
  await expect(cabinet.locator('#category-add-error')).toHaveCount(0);
  await cabinet.getByRole('button', { name: 'Nowa kategoria' }).click();
  await expect(headings).toHaveText(['Włosy', 'Broda i golenie', 'Dzieci']);
  await shot(cabinet, '254-category-order');
  await expect.poll(categories).toEqual(['Włosy', 'Broda i golenie', 'Dzieci']);

  // Task Q6: search and filters over the services, as in "Mój sklep"; the arrows wait meanwhile.
  await cabinet.getByLabel('Szukaj usługi').fill('bro');
  await expect(headings).toHaveText(['Broda i golenie']);
  await expect(cabinet.getByText('Trymowanie brody')).toBeVisible();
  await expect(cabinet.getByText('Strzyżenie męskie')).toHaveCount(0);
  await expect(cabinet.getByRole('button', { name: /^Wyżej:/ })).toHaveCount(0);
  await cabinet.getByLabel('Szukaj usługi').fill('');
  // Nobody performs them yet — the filter shows both.
  await cabinet.getByRole('button', { name: 'Bez specjalisty 2' }).click();
  await expect(headings).toHaveText(['Włosy', 'Broda i golenie']);
  await expect(cabinet.getByRole('button', { name: 'Ukryte' })).toHaveCount(0);
  await shot(cabinet, 'q6-services-list');
  await cabinet.getByRole('button', { name: 'Wszystkie 2' }).click();
  await expect(headings).toHaveText(['Włosy', 'Broda i golenie', 'Dzieci']);
  // The order hint is under "?".
  await cabinet.locator('[aria-controls="services-help"]').click();
  await expect(cabinet.getByText(/strzałkami ustaw, co pierwsze/)).toBeVisible();
  await desk.close();
});
