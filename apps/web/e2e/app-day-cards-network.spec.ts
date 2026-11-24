import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DICTIONARIES, fill } from '../../mobile-business/src/i18n';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const address = freshAddress();
const account = { email: `cf-${randomUUID()}@example.com`, password: randomUUID() };
let base: string;
let app: Awaited<ReturnType<typeof serveApp>>;

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test.beforeAll(async ({ request }) => {
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Anna' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(account.email, /Potwierdź adres/);
  const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]!);
  await expect(
    await request.post('/v1/auth/verify-email', { headers: address, data: { token } }),
  ).toBeOK();
  const login = await request.post('/v1/auth/login', { headers: address, data: account });
  await expect(login).toBeOK();
  const headers = { ...address, Authorization: `Bearer ${(await login.json()).accessToken}` };
  async function create(path: string, data: object): Promise<string> {
    const response = await request.post(path, { headers, data });
    await expect(response).toBeOK();
    return (await response.json()).id;
  }
  const org = await create('/v1/organizations', { name: 'Studio CF' });
  const locations = `/v1/organizations/${org}/locations`;
  const salon = await create(locations, {
    name: 'Studio CF',
    city: 'Warszawa',
    addressLine: 'Bema 91',
    postalCode: '01-233',
  });
  base = `${locations}/${salon}`;
  const service = await create(`${base}/services`, {
    name: 'Stylizacja',
    priceGrosze: 2500,
    durationMinutes: 30,
  });
  await create(`${base}/staff`, { displayName: 'Anna', serviceIds: [service] });
  for (const name of ['Pomada', 'Wosk'])
    await create(`${base}/products`, { name, priceGrosze: 2500, stockQuantity: 8 });
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
});

test.afterAll(() => app?.server.close());

test('a failed setup card retries independently and returning to the day reuses both cards', async ({
  page,
}) => {
  const setup = page.getByRole('group', { name: t.setup.title });
  const now = page.getByTestId('clients-now').getByRole('heading');
  const calendar = page.getByRole('button', { name: t.day.sharePlan });
  let setupReads = 0;
  let locationReads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === base) locationReads++;
  });
  await page.route(`**${base}/staff/*/working-hours`, async (route) => {
    if (++setupReads === 1) {
      await expect(setup.getByRole('progressbar')).toBeVisible();
      await expect(now).toHaveAccessibleDescription(t.salon.onlineOff);
      await expect(calendar).toBeVisible();
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await page.goto(app.url);
  await expect(setup.getByRole('alert')).toHaveText(t.error.network);
  await expect(calendar).toBeVisible();
  await setup.getByRole('button', { name: `${t.day.refresh}: ${t.setup.title}` }).click();
  const summary = fill(t.setup.lead, { n: '3' });
  await expect(setup.getByRole('heading')).toHaveAccessibleDescription(summary);
  expect(setupReads).toBe(2);
  const readsBeforeLeaving = locationReads;
  await page.getByRole('tab', { name: t.navigation.more, exact: true }).click();
  await expect(setup).toBeHidden();
  await page.getByRole('tab', { name: t.navigation.calendar, exact: true }).click();
  await expect(setup.getByRole('heading')).toHaveAccessibleDescription(summary);
  await expect(now).toHaveAccessibleDescription(t.salon.onlineOff);
  expect(setupReads).toBe(2);
  expect(locationReads).toBe(readsBeforeLeaving);
});

test('Base retries locally and a failed stocktake keeps both counts for the next save', async ({
  page,
}) => {
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  await page.route(`**${base}/shop/integrations/base`, (route) => route.abort(), { times: 1 });
  await page.goto(app.url);
  await tab(t.shop.open).click();
  await tab(t.navigation.integrations).click();
  await expect(page.getByRole('alert')).toHaveText(t.error.network);
  await page.getByRole('button', { name: `${t.day.refresh}: ${t.shop.base.title}` }).click();
  await expect(page.getByRole('heading', { name: t.shop.base.title })).toHaveAccessibleDescription(
    t.shop.base.off,
  );

  await tab(t.navigation.products).click();
  await page.getByRole('button', { name: `${t.navigation.inventory} ▸` }).click();
  await page.getByRole('button', { name: t.products.stocktake, exact: true }).click();
  const stock = page.getByTestId('stocktake');
  const count = (name: string) =>
    stock.getByRole('textbox', { name: fill(t.products.stocktakeCount, { name }) });
  const save = stock.getByRole('button', { name: t.products.stocktakeSave });
  await count('Pomada').fill('5');
  await count('Wosk').fill('10');
  const payloads: unknown[] = [];
  await page.route(`**${base}/products/stocktake`, async (route) => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) {
      await expect(save).toBeDisabled();
      await save.dispatchEvent('click');
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await save.click();
  await expect(stock.getByRole('alert')).toHaveText(t.error.network);
  await expect(count('Pomada')).toHaveValue('5');
  await expect(count('Wosk')).toHaveValue('10');
  expect(payloads).toHaveLength(1);
  await save.click();
  await expect(page.getByTestId('stocktake-done')).toHaveText(
    fill(t.products.stocktakeDone, { changed: '2', missing: '3', extra: '2' }),
  );
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
});

test('a slow commissions request can be retried from the report', async ({ page }) => {
  await page.goto(app.url);
  await openBusinessMenu(page, t.reports.open);
  const section = page.getByTestId('report-commissions');
  const open = section.getByRole('button', { name: t.reports.commissionsSet });
  let reads = 0;
  await page.route(`**${base}/reports/commissions`, async (route) => {
    if (++reads === 1) {
      await expect(open).toBeDisabled();
      await open.dispatchEvent('click');
      await route.abort();
    } else await route.continue();
  });
  await open.click();
  await expect(section.getByRole('alert')).toHaveText(t.error.network);
  await section.getByRole('button', { name: t.day.refresh }).click();
  const field = section.getByRole('textbox', {
    name: fill(t.reports.commissionLabel, { name: 'Anna' }),
  });
  await expect(field).toBeVisible();
  await section.getByRole('button', { name: t.reports.commissionsHide }).click();
  await open.click();
  await expect(field).toBeVisible();
  expect(reads).toBe(2);
});
