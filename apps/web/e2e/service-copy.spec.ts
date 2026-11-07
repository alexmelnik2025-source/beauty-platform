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
 * Task 251: "Duplikuj usługę". The owner opens "Strzyżenie męskie" (90 zł, 45 min, Kasia with
 * her own 75 zł) and presses "Duplikuj": a new-service window opens, already filled in —
 * "Strzyżenie męskie (kopia)", the same price, time and specialists, Kasia's own price. Closing
 * it creates nothing; after renaming and "Zapisz" the copy is on the list with Kasia's price,
 * and the original is unchanged. Task 252: "↑" puts the copy first — the order clients see.
 * Screenshots 251, 252.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `copy-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

interface Service {
  id: string;
  name: string;
  priceGrosze: number;
  durationMinutes: number;
  staffIds: string[];
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
    await api.post('/v1/organizations', { headers: owner, data: { name: 'Kopia Barber' } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Kopia Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const haircut = await json<Service>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const ids: string[] = [];
  for (const name of ['Kasia', 'Marek']) {
    const staff = await json<{ id: string }>(
      await api.post(`${base}/staff`, {
        headers: owner,
        data: { displayName: name, serviceIds: [haircut.id] },
      }),
    );
    ids.push(staff.id);
  }
  await json(
    await api.put(`${base}/services/${haircut.id}/staff-prices`, {
      headers: owner,
      data: { prices: [{ staffId: ids[0], priceGrosze: 7500 }] },
    }),
  );
  return { owner, base, haircut, staffIds: ids, kasia: ids[0]!, address };
}

test('the owner duplicates a service — the copy is filled in and saved only on "Zapisz"', async ({
  browser,
  request,
}) => {
  const { owner, base, haircut, staffIds, kasia, address } = await salon(request);
  const services = async () =>
    json<Service[]>(await request.get(`${base}/services`, { headers: owner }));

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

  // Open the service, press "Duplikuj": the window is a new, filled-in service.
  await cabinet.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  let dialog = cabinet.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Duplikuj' }).click();
  dialog = cabinet.getByRole('dialog');
  await expect(dialog.getByTestId('service-copy-hint')).toBeVisible();
  await expect(dialog.getByLabel('Nazwa', { exact: true })).toHaveValue(
    'Strzyżenie męskie (kopia)',
  );
  await expect(dialog.getByLabel('Czas trwania (min)', { exact: true })).toHaveValue('45');
  await expect(dialog.getByLabel(/^Cena \(/)).toHaveValue('90.00');
  await expect(dialog.getByRole('checkbox', { name: /Kasia/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Marek/ })).toBeChecked();
  await expect(dialog.getByLabel('Cena u: Kasia', { exact: true })).toHaveValue('75.00');
  await shot(cabinet, '251-service-duplicate');

  // Closing the window creates nothing.
  await cabinet.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await services()).map((s) => s.name)).toEqual(['Strzyżenie męskie']);

  // Again — rename the copy and save it.
  await cabinet.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await cabinet.getByRole('dialog').getByRole('button', { name: 'Duplikuj' }).click();
  dialog = cabinet.getByRole('dialog');
  await dialog.getByLabel('Nazwa', { exact: true }).fill('Strzyżenie + broda');
  await dialog.getByRole('button', { name: 'Zapisz' }).click();
  await expect(dialog).toBeHidden();
  await expect(cabinet.locator('.list-row', { hasText: 'Strzyżenie + broda' })).toBeVisible();

  const list = await services();
  const copy = list.find((s) => s.name === 'Strzyżenie + broda')!;
  expect(copy).toBeTruthy();
  expect(copy.id).not.toBe(haircut.id);
  expect(copy.priceGrosze).toBe(9000);
  expect(copy.durationMinutes).toBe(45);
  expect([...copy.staffIds].sort()).toEqual([...staffIds].sort());
  const prices = await json<{
    prices: { serviceId: string; staffId: string; priceGrosze: number }[];
  }>(await request.get(`${base}/staff-prices`, { headers: owner }));
  expect(prices.prices.filter((p) => p.serviceId === copy.id)).toEqual([
    expect.objectContaining({ staffId: kasia, priceGrosze: 7500 }),
  ]);
  // The original keeps its name and Kasia's price.
  expect(list.find((s) => s.id === haircut.id)?.name).toBe('Strzyżenie męskie');
  expect(prices.prices.filter((p) => p.serviceId === haircut.id)).toHaveLength(1);

  // Task 252: the copy goes first — "↑" by it; the first one has no way up.
  await expect(cabinet.getByRole('button', { name: 'Wyżej: Strzyżenie męskie' })).toBeDisabled();
  await cabinet.getByRole('button', { name: 'Wyżej: Strzyżenie + broda' }).click();
  await expect(cabinet.getByRole('button', { name: 'Wyżej: Strzyżenie + broda' })).toBeDisabled();
  await expect(cabinet.locator('.list-row strong')).toHaveText([
    'Strzyżenie + broda',
    'Strzyżenie męskie',
  ]);
  await shot(cabinet, '252-service-order');
  expect((await services()).map((s) => s.name)).toEqual([
    'Strzyżenie + broda',
    'Strzyżenie męskie',
  ]);
  await desk.close();
});
