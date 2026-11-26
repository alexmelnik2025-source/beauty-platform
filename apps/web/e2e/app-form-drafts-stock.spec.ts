import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const account = { email: `drafts-${randomUUID()}@example.com`, password: randomUUID() };
const address = freshAddress();
let app: Awaited<ReturnType<typeof serveApp>>;
let headers: Record<string, string>;
let base: string;
let waxId: string;

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test.beforeAll(async ({ request }) => {
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Ewa' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(account.email, /Potwierdź adres/);
  const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]!);
  await expect(await request.post('/v1/auth/verify-email', { data: { token } })).toBeOK();
  const login = await request.post('/v1/auth/login', { headers: address, data: account });
  await expect(login).toBeOK();
  headers = { ...address, Authorization: `Bearer ${(await login.json()).accessToken}` };
  async function create(path: string, data: object): Promise<string> {
    const res = await request.post(path, { headers, data });
    await expect(res).toBeOK();
    return (await res.json()).id;
  }
  const org = await create('/v1/organizations', { name: 'Studio DN' });
  const locations = `/v1/organizations/${org}/locations`;
  const salon = await create(locations, {
    name: 'Studio DN',
    addressLine: 'Bema 91',
    city: 'Warszawa',
    postalCode: '01-233',
  });
  base = `${locations}/${salon}`;
  await create(`${base}/products`, {
    name: 'Pomada',
    priceGrosze: 1000,
    stockQuantity: 8,
    supplier: 'Alfa',
  });
  waxId = await create(`${base}/products`, {
    name: 'Wosk',
    priceGrosze: 2000,
    stockQuantity: 4,
    lowStockAt: 2,
    supplier: 'Beta',
  });
  for (const displayName of ['Anna', 'Marek']) await create(`${base}/staff`, { displayName });
  app = await serveApp('mobile-business');
});

test.beforeEach(async ({ page, request }) => {
  const login = await request.post('/v1/auth/login', {
    headers: address,
    data: { ...account, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  await page.addInitScript(
    (token) => localStorage.setItem('beauty.business.refreshToken', token),
    (await login.json()).refreshToken,
  );
  await page.goto(app.url);
});

test.afterAll(() => app?.server.close());

async function openWarehouse(page: Page) {
  await page.getByRole('tab', { name: 'Sklep', exact: true }).click();
  await page.getByRole('button', { name: 'Magazyn ▸', exact: true }).click();
  await page.getByRole('button', { name: 'Inwentaryzacja', exact: true }).click();
  await page.getByRole('button', { name: 'Przyjmij dostawę', exact: true }).click();
}

test('stock counts and deliveries restore edited rows and supplier, then clear after save or cancel', async ({
  page,
  request,
}) => {
  const stock = page.getByTestId('stocktake');
  const delivery = page.getByTestId('delivery');
  const count = stock.getByLabel('Na półce — Pomada');
  const pieces = delivery.getByLabel('Przyszło — Pomada');
  const all = delivery.getByRole('button', { name: 'Wszyscy dostawcy' });
  const alfa = delivery.getByRole('button', { name: 'Alfa' });
  const saveCount = stock.getByRole('button', { name: 'Zapisz inwentaryzację' });
  const saveDelivery = delivery.getByRole('button', { name: 'Przyjmij dostawę (4 szt.)' });
  const calendar = page.getByRole('tab', { name: 'Kalendarz', exact: true });

  await openWarehouse(page);
  await count.fill('005');
  await alfa.click();
  await pieces.fill('4');
  await page.route(`**${base}/products/stocktake`, (route) => route.abort(), { times: 1 });
  await saveCount.click();
  await expect(stock.getByRole('alert')).toBeVisible();
  await page.route(`**${base}/products/delivery`, (route) => route.abort(), { times: 1 });
  await saveDelivery.click();
  await expect(delivery.getByRole('alert')).toBeVisible();

  await calendar.click();
  await expect(stock).toBeHidden();
  await expect(
    await request.patch(`${base}/products/${waxId}`, { headers, data: { stockQuantity: 0 } }),
  ).toBeOK();
  await openWarehouse(page);
  await expect(stock.getByRole('alert')).toHaveCount(0);
  await expect(delivery.getByRole('alert')).toHaveCount(0);
  await expect(count).toHaveValue('005');
  await expect(stock.getByLabel('Na półce — Wosk')).toHaveValue('0');
  await expect(alfa).toHaveAttribute('aria-pressed', 'true');
  await expect(pieces).toHaveValue('4');
  await expect(delivery.getByLabel('Przyszło — Wosk')).toHaveCount(0);
  await all.click();
  await expect(delivery.getByLabel('Przyszło — Wosk')).toHaveValue('3');
  await alfa.click();

  await saveCount.click();
  await expect(page.getByTestId('stocktake-done')).toBeVisible();
  await saveDelivery.click();
  await expect(page.getByTestId('delivery-done')).toHaveText(
    'Dostawa przyjęta: 4 szt., produktów: 1.',
  );
  await calendar.click();
  await openWarehouse(page);
  await expect(count).toHaveValue('9');
  await expect(saveCount).toBeDisabled();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(pieces).toHaveValue('');

  await count.fill('1');
  await stock.getByRole('button', { name: 'Anuluj' }).click();
  await alfa.click();
  await pieces.fill('7');
  await delivery.getByRole('button', { name: 'Anuluj' }).click();
  await calendar.click();
  await openWarehouse(page);
  await expect(count).toHaveValue('9');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(pieces).toHaveValue('');
  await expect(delivery.getByLabel('Przyszło — Wosk')).toHaveValue('3');
});

test('reopening a pending delivery cannot add the same pieces twice', async ({ page, request }) => {
  await expect(
    await request.post(`${base}/products`, {
      headers,
      data: { name: 'Puder', supplier: 'Gamma', priceGrosze: 1500, stockQuantity: 3 },
    }),
  ).toBeOK();
  await openWarehouse(page);
  const delivery = page.getByTestId('delivery');
  const save = delivery.getByRole('button', { name: 'Przyjmij dostawę (2 szt.)' });
  await delivery.getByRole('button', { name: 'Gamma' }).click();
  await delivery.getByLabel('Przyszło — Puder').fill('2');

  let release!: () => void;
  const holdResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  let status = 0;
  await page.route(`**${base}/products/delivery`, async (route) => {
    posts++;
    const response = await route.fetch();
    status = response.status();
    await holdResponse;
    await route.fulfill({ response });
  });
  try {
    await save.click();
    await expect.poll(() => status).toBe(200);
    await page.getByRole('tab', { name: 'Kalendarz', exact: true }).click();
    await openWarehouse(page);
    await expect(save).toBeDisabled();
    await save.dispatchEvent('click');
  } finally {
    release();
  }
  await expect(page.getByTestId('delivery-done')).toHaveText(
    'Dostawa przyjęta: 2 szt., produktów: 1.',
  );
  await page.getByRole('button', { name: 'Przyjmij dostawę', exact: true }).click();
  await expect(delivery.getByLabel('Przyszło — Puder')).toHaveValue('');
  await expect(page.getByLabel('Na półce — Puder')).toHaveValue('5');
  expect(posts).toBe(1);
});

test('commission drafts survive leaving reports and clear separately for each specialist', async ({
  page,
}) => {
  const commissions = page.getByTestId('report-commissions');
  const open = async () => {
    await openBusinessMenu(page, 'Raporty');
    await commissions.getByRole('button', { name: 'Ustaw prowizje' }).click();
  };
  const anna = commissions.getByLabel('Prowizja, % — Anna');
  const marek = commissions.getByLabel('Prowizja, % — Marek');
  const save = commissions.getByRole('button', { name: 'Zapisz prowizję — Anna' });
  const back = page.getByRole('button', { name: '‹ Wróć', exact: true });

  await open();
  await anna.fill('12.5');
  await marek.fill('41');
  await page.route(`**${base}/reports/commissions/*`, (route) => route.abort(), { times: 1 });
  await save.click();
  await expect(commissions.getByRole('alert')).toBeVisible();
  await back.click();
  await open();
  await expect(commissions.getByRole('alert')).toHaveCount(0);
  await expect(anna).toHaveValue('12.5');
  await expect(marek).toHaveValue('41');

  await save.click();
  await expect(anna).toHaveValue('12,5');
  await expect(marek).toHaveValue('41');
  await commissions.getByRole('button', { name: 'Anuluj — Marek' }).click();
  await back.click();
  await open();
  await expect(anna).toHaveValue('12,5');
  await expect(marek).toHaveValue('');
});
