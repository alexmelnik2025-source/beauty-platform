import { expect, test, type Page } from '@playwright/test';
import type { GiftVoucher } from '../../mobile-business/src/api';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const v = pl.vouchers;
const org = '**/v1/organizations/ea';
const collection = org + '/locations/salon/gift-vouchers';
const voucher: GiftVoucher = {
  id: 'gift',
  code: 'ABCD1234',
  amountGrosze: 10000,
  balanceGrosze: 10000,
  validUntil: null,
  recipient: null,
  note: null,
  status: 'active',
  soldDate: '2026-11-26',
  paymentMethod: null,
  soldByName: null,
  cancelledAt: null,
};
const list = (item: GiftVoucher) => ({
  vouchers: [item],
  activeBalanceGrosze: item.status === 'active' ? item.balanceGrosze : 0,
  expiringSoon: { count: 0, balanceGrosze: 0, until: '2026-12-26' },
});
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'ea-session'),
  );
  const reply = (path: string, json: unknown) =>
    page.route(path, (route) => route.fulfill({ json }));
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply('**/v1/auth/refresh', { accessToken: 'ea-access', refreshToken: 'ea-session' });
  await reply('**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'ea', role: 'owner', name: 'Studio EA' }],
  });
  await reply(org + '/locations', [
    {
      id: 'salon',
      name: 'Studio EA',
      city: 'Warszawa',
      timezone: 'Europe/Warsaw',
      currency: 'PLN',
    },
  ]);
  await reply(collection, list(voucher));
  await page.goto(app.url);
  const more = page.getByRole('tab', { name: pl.navigation.more, exact: true });
  await more.click();
  const title = button(page, v.open).getByText(v.open, { exact: true });
  const fontSize = () => title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(original * 1.3, 1);
});

test('the voucher list can retry its first offline read without leaving the screen', async ({
  page,
}) => {
  let reads = 0;
  await page.route(collection, (route) => {
    reads++;
    return reads === 1
      ? route.abort('internetdisconnected')
      : route.fulfill({ json: list(voucher) });
  });
  await openBusinessMenu(page, v.open);
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await button(page, pl.day.refresh).click();
  await expect(button(page, v.show + ' ' + voucher.code)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(reads).toBe(2);
});

test('empty and whitespace voucher codes show a field error and a corrected code can be checked', async ({
  page,
}) => {
  const checks: string[] = [];
  await page.route(collection + '/code/**', (route) => {
    checks.push(new URL(route.request().url()).pathname.split('/').pop()!);
    return route.fulfill({ json: { voucher, uses: [] } });
  });
  await openBusinessMenu(page, v.open);
  const code = page.getByRole('textbox', { name: v.code, exact: true });
  const check = button(page, v.check);
  for (const value of ['', '   ']) {
    await code.fill(value);
    await check.click();
    await expect(code).toHaveAttribute('aria-invalid', 'true');
    await expect(code.locator('..').getByRole('alert')).toContainText(
      fill(pl.salon.missing, { list: v.code }),
    );
  }
  expect(checks).toEqual([]);
  await code.fill(voucher.code);
  await expect(code.locator('..').getByRole('alert')).toHaveCount(0);
  await check.click();
  await expect(page.getByText(v.noUses, { exact: true })).toBeVisible();
  expect(checks).toEqual([voucher.code]);
});

test('two cancellation confirmations send one request and a failed cancellation can be retried', async ({
  page,
}) => {
  let current = voucher;
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(collection, (route) => route.fulfill({ json: list(current) }));
  await page.route(collection + '/gift/cancel', async (route) => {
    expect(route.request().method()).toBe('POST');
    if (++attempts === 1) {
      await pending;
      return route.abort('connectionreset');
    }
    current = { ...voucher, status: 'cancelled', cancelledAt: '2026-11-26T16:50:00Z' };
    return route.fulfill({ json: current });
  });

  await openBusinessMenu(page, v.open);
  await button(page, v.cancel + ' ' + voucher.code).click();
  const confirm = button(page, v.cancelYes);
  try {
    await confirm.evaluate((el) => {
      (el as HTMLElement).click();
      (el as HTMLElement).click();
    });
    await expect.poll(() => attempts).toBe(1);
    await expect(confirm).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await expect(confirm).toBeEnabled();
  expect(attempts).toBe(1);
  await confirm.click();
  await expect(page.getByRole('status')).toHaveText(fill(v.cancelled, { code: voucher.code }));
  await expect(
    page.getByText(voucher.code + ' · ' + v.statusCancelled, { exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});
