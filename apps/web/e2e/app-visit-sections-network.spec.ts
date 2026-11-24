import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const customer = 'Katarzyna Kowalska';
const product = 'Odżywka';
const barcode = '5901234567893';
async function createVisit(request: APIRequestContext) {
  const account = { email: `ce-${crypto.randomUUID()}@example.com`, password: crypto.randomUUID() };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Anna' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(account.email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      headers: address,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await request.post('/v1/auth/login', {
    headers: address,
    data: { ...account, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const { accessToken, refreshToken } = await login.json();
  async function create(path: string, data: object): Promise<string> {
    const response = await request.post(path, {
      headers: { ...address, Authorization: `Bearer ${accessToken}` },
      data,
    });
    await expect(response).toBeOK();
    return (await response.json()).id;
  }
  const org = await create('/v1/organizations', { name: 'Salon CE' });
  const locations = `/v1/organizations/${org}/locations`;
  const location = await create(locations, {
    name: 'Salon CE',
    city: 'Warszawa',
    postalCode: '00-001',
    addressLine: 'Bema 1',
  });
  const base = `${locations}/${location}`;
  const serviceId = await create(`${base}/services`, {
    name: 'Strzyżenie',
    durationMinutes: 30,
    priceGrosze: 9000,
  });
  const staffId = await create(`${base}/staff`, { displayName: 'Anna', serviceIds: [serviceId] });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const start = new Date(Date.parse(today + 'T12:00:00Z') - 86_400_000).toISOString();
  const id = await create(`${base}/appointments`, {
    start,
    serviceId,
    staffId,
    alreadyHappened: true,
    allowOutsideHours: true,
    customer: { name: customer, phone: '+48600123456' },
  });
  await create(`${base}/products`, { name: product, priceGrosze: 2900, stockQuantity: 4, barcode });
  return { today, base, path: `${base}/appointments/${id}`, refreshToken };
}

// Hold the write until the pending UI is visible. Abort before it reaches the API,
// then remove only this handler so a deliberate retry can go through normally.
async function interruptWrite(
  page: Page,
  path: string,
  control: Locator,
  feedback: Locator,
  pendingControl = control,
) {
  const pattern = `**${path}`;
  const writes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    if (route.request().method() === 'GET') return route.fallback();
    writes.push(route.request().method());
    await gate;
    await route.abort('connectionreset');
  };
  await page.route(pattern, handler);
  try {
    await expect(control).toBeEnabled();
    await control.evaluate((el: HTMLElement) => {
      el.click();
      el.click();
    });
    await expect.poll(() => writes.length).toBe(1);
    await expect(pendingControl).toBeDisabled();
    release();
    await expect(feedback).toContainText(pl.error.network);
    await expect(control).toBeEnabled();
    expect(writes).toHaveLength(1);
  } finally {
    release();
    await page.unroute(pattern, handler);
  }
}

test.use({
  baseURL: process.env.API_URL ?? 'http://localhost:4000',
  viewport: { width: 320, height: 844 },
  isMobile: true,
  locale: 'pl-PL',
});

test('visit actions keep drafts and send one write on a slow or broken connection', async ({
  page,
  request,
}) => {
  const { today, base, path, refreshToken } = await createVisit(request);
  const button = (scope: Page | Locator, name: string) =>
    scope.getByRole('button', { name, exact: true });
  const w = pl.waitlist;
  const c = pl.visit.coupons;
  const v = pl.vouchers;
  const p = pl.products;
  const entry = {
    id: 'ce',
    name: customer,
    date: today,
    status: 'waiting',
    createdAt: today + 'T08:00:00Z',
    serviceName: 'Strzyżenie',
    email: 'ce@example.com',
  };
  await page.route(`**${base}/waitlist?*`, (route) => route.fulfill({ json: { items: [entry] } }));
  const coupon = { id: 'ce', code: 'TEST24', name: 'Rabat', discountGrosze: 500, problem: null };
  await page.route(`**${path}/coupons`, (route) =>
    route.fulfill({ json: { tier: null, applied: [coupon], available: [] } }),
  );
  await page.route(`**${path}/reservations`, (route) =>
    route.fulfill({
      json: {
        reservations: [
          { id: 'ce', name: product, quantity: 1, totalGrosze: 2900, status: 'reserved' },
        ],
        toHandGrosze: 2900,
      },
    }),
  );
  await page.route(`**${base}/gift-vouchers/code/ABCD1234`, (route) =>
    route.fulfill({ json: { voucher: { id: 'ce' } } }),
  );
  const app = await serveApp('mobile-business');
  try {
    await page.addInitScript(
      (token) => localStorage.setItem('beauty.business.refreshToken', token),
      refreshToken,
    );
    await page.goto(app.url);
    await test.step('waitlist removal keeps the confirmation ready for retry', async () => {
      const list = page.getByLabel(w.title, { exact: true });
      await button(list, `${w.remove}: ${customer}`).click();
      await interruptWrite(
        page,
        `${base}/waitlist/ce/remove`,
        button(list, w.removeYes),
        list.getByRole('alert'),
      );
      await button(list, w.removeNo).click();
    });

    await button(page, pl.day.previous).click();
    await page.getByRole('button', { name: new RegExp(customer) }).click();
    await test.step('coupon actions and voucher redemption keep the entered code and amount', async () => {
      const coupons = page.getByRole('heading', { name: c.title }).locator('..');
      await interruptWrite(
        page,
        `${path}/coupons/ce/remove`,
        button(coupons, fill(c.removeOne, { code: coupon.code })),
        coupons.getByRole('alert'),
      );
      const code = coupons.getByRole('textbox', { name: c.code, exact: true });
      await code.fill('PROMO24');
      await interruptWrite(
        page,
        `${path}/coupons`,
        button(coupons, c.useCode),
        coupons.getByRole('alert'),
      );
      await expect(code).toHaveValue('PROMO24');
      await expect(code).toHaveAccessibleDescription(`! ${pl.error.network}`);

      const vouchers = page.getByTestId('visit-vouchers');
      await button(vouchers, v.visitOpen).click();
      const voucherCode = vouchers.getByLabel(v.code, { exact: true });
      const amount = vouchers.getByLabel(v.payAmount, { exact: true });
      await voucherCode.fill('ABCD-1234');
      await amount.fill('12,50');
      await interruptWrite(
        page,
        `${base}/gift-vouchers/ce/redeem`,
        button(vouchers, v.pay),
        vouchers.getByRole('alert'),
      );
      await expect(voucherCode).toHaveValue('ABCD-1234');
      await expect(amount).toHaveValue('12,50');
      await expect(amount).toHaveAccessibleDescription(`! ${pl.error.network}`);
    });

    await test.step('reserved product and barcode sale can be retried', async () => {
      const hand = page.getByTestId('visit-to-hand');
      await interruptWrite(
        page,
        `${path}/reservations/ce/hand-over`,
        button(hand, fill(p.toHandGiveFor, { name: product })),
        hand.getByRole('alert'),
      );
      const sales = page.getByTestId('visit-products');
      const code = sales.getByLabel(p.saleByCode);
      await code.fill(barcode);
      const add = button(sales, p.addByCode);
      await interruptWrite(page, `${path}/products`, add, sales.getByRole('alert'));
      await expect(code).toHaveAccessibleDescription(`! ${pl.error.network}`);
      await expect(code).toHaveValue(barcode);
      await add.click();
      await expect(code).toHaveValue('');
      await expect(button(sales, fill(p.removeSaleFor, { name: product }))).toBeVisible();
    });

    await test.step('payment method survives interrupted payment and method change', async () => {
      const card = page.getByRole('radio', { name: pl.visit.paymentMethods.card });
      await card.click();
      const paid = button(page, pl.visit.markPaid);
      await page.route(`**${path}/payment`, (route) => route.abort('connectionreset'), {
        times: 1,
      });
      await paid.click();
      const paymentError = page.getByText(pl.error.network, { exact: true });
      await expect(paymentError).toBeVisible();
      await expect(card).toBeChecked();
      await paid.click();
      await expect(button(page, pl.visit.unmarkPaid)).toBeVisible();
      const cash = page.getByRole('radio', { name: pl.visit.paymentMethods.cash });
      await interruptWrite(page, `${path}/payment`, cash, paymentError);
      await expect(cash).toBeChecked();
      const save = button(page, pl.day.tillSave);
      await expect(page.getByText(pl.navigation.unsaved, { exact: true })).toBeVisible();
      await interruptWrite(page, `${path}/payment`, save, paymentError, cash);
      await save.click();
      await expect(page.getByText('✓ Opłacono · Gotówka', { exact: true })).toBeVisible();
    });

    await test.step('delivery preserves quantity and accepts one explicit retry', async () => {
      await button(page, pl.visit.back).click();
      await page.getByRole('tab', { name: 'Sklep', exact: true }).click();
      await button(page, 'Magazyn ▸').click();
      await button(page, p.deliveryTitle).click();
      const delivery = page.getByTestId('delivery');
      const quantity = delivery.getByLabel(fill(p.deliveryCame, { name: product }));
      await quantity.fill('3');
      const save = button(delivery, fill(p.deliverySave, { n: '3' }));
      await interruptWrite(page, `${base}/products/delivery`, save, delivery.getByRole('alert'));
      await expect(quantity).toHaveValue('3');
      await expect(quantity).toHaveAccessibleDescription(`! ${pl.error.network}`);
      await save.click();
      await expect(page.getByTestId('delivery-done')).toBeVisible();
    });
  } finally {
    app.server.close();
  }
});
