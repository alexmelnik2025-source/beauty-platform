import { expect, test, type Page, type Route } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const org = '**/v1/organizations/org';
const client = { id: 'anna', name: 'Anna Kowalska', phone: null, email: null };
const detailPath = org + '/customers/anna';
const accountPath = org + '/loyalty/accounts/anna';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const reply = (page: Page, path: string, json: unknown) =>
  page.route(path, (route) => route.fulfill({ json }));

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 740 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'session'));
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply(page, '**/v1/auth/refresh', { accessToken: 'access', refreshToken: 'session' });
  await reply(page, '**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'org', name: 'Salon', role: 'owner' }],
  });
  await reply(page, org + '/locations', [
    { id: 'salon', name: 'Salon', city: 'Warszawa', timezone: 'Europe/Warsaw', currency: 'PLN' },
  ]);
  await reply(page, org + '/customers?*', [client]);
  await reply(page, detailPath, {
    ...client,
    tags: [],
    note: null,
    marketingConsent: null,
    summary: {},
    visits: [],
    products: { purchases: [], totals: [] },
  });

  await page.goto(app.url);
  await page.getByRole('tab', { name: pl.clients.open, exact: true }).click();
  const name = page.getByText(client.name, { exact: true });
  const fontSize = () => name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
});

test('retry the first failed customer read without leaving the card', async ({ page }) => {
  await page.route(detailPath, (route) => route.abort('internetdisconnected'), { times: 1 });
  await button(page, pl.clients.card + ': ' + client.name).click();
  const error = page.getByRole('alert');
  await expect(error).toHaveText(pl.error.network);
  await button(page, pl.day.refresh).click();
  await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
  await expect(error).toHaveCount(0);
  await expect(button(page, pl.day.refresh)).toHaveCount(0);
});

test('one bonus adjustment per confirmation, including after a failed attempt', async ({
  page,
}) => {
  const b = pl.clients.bonus;
  const account = { mode: 'stamps', balance: 3, lifetimeEarned: 3, coupons: [], transactions: [] };
  await reply(page, org + '/loyalty/program', { enabled: true });
  await reply(page, org + '/loyalty/rewards', []);
  await reply(page, accountPath, account);
  const writes: unknown[] = [];
  let pending: Route | undefined;
  await page.route(accountPath + '/adjustments', (route) => {
    expect(route.request().method()).toBe('POST');
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) {
      pending = route;
      return;
    }
    return route.fulfill({ json: { ...account, balance: 13 } });
  });

  await button(page, pl.clients.card + ': ' + client.name).click();
  await button(page, pl.navigation.more).click();
  await button(page, b.adjustOpen).click();
  const reason = 'Papierowa karta';
  await page.getByLabel(b.adjustPoints).fill('10');
  await page.getByLabel(b.adjustReason).fill(reason);
  const save = button(page, b.adjust);
  const confirmTwice = () =>
    save.evaluate((element: HTMLElement) => {
      element.click();
      element.click();
    });
  await confirmTwice();
  await expect(save).toBeDisabled();
  await expect.poll(() => writes).toEqual([{ points: 10, reason }]);
  await pending!.abort('internetdisconnected');

  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await expect(save).toBeEnabled();
  await expect(page.getByLabel(b.adjustPoints)).toHaveValue('10');
  await expect(page.getByLabel(b.adjustReason)).toHaveValue(reason);
  await confirmTwice();
  await expect(page.getByRole('status')).toHaveText(b.adjusted);
  await expect(
    page.getByText(pl.clients.stamps.replace('{count}', '13'), { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    { points: 10, reason },
    { points: 10, reason },
  ]);
});
