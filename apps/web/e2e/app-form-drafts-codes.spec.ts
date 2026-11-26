import { expect, test, type Page } from '@playwright/test';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const date = '2026-11-25';
const base = '/v1/organizations/org/locations/salon';
const location = { id: 'salon', name: 'Salon DM', timezone: 'Europe/Warsaw', currency: 'PLN' };
const product = {
  id: 'cream',
  name: 'Krem',
  barcode: 'DM1234',
  priceGrosze: 2500,
  active: true,
  stockQuantity: null,
};
const coupon = { id: 'coupon', name: 'Rabat', code: 'DM25', discountGrosze: 500, problem: null };

function appointment(id: string, name: string, hour: string, priceGrosze: number) {
  return {
    id,
    version: 1,
    date,
    time: hour + ':00',
    start: `${date}T${hour}:00:00+01:00`,
    end: `${date}T${hour}:30:00+01:00`,
    status: 'completed',
    service: { id: 'service', name: 'Strzyżenie' },
    staff: { id: 'staff', displayName: 'Anna' },
    customer: { id: name, name },
    priceGrosze,
    discountGrosze: 0,
    paidAt: null,
    tipGrosze: 0,
    durationMinutes: 30,
  };
}

async function mockSalon(page: Page, slowRetry?: Promise<void>) {
  const first = appointment('first', 'Ewa', '10', 8000);
  const second = appointment('second', 'Jan', '11', 6000);
  const firstPath = base + '/appointments/first';
  const redeem = base + '/gift-vouchers/voucher/redeem';
  const failOnce = new Set(
    slowRetry ? [firstPath + '/coupons', firstPath + '/products', redeem] : [],
  );
  const sale = { id: 'sale', name: product.name, quantity: 1, totalGrosze: product.priceGrosze };
  const payment = { id: 'payment', code: 'ABCD1234', amountGrosze: 1250, time: '12:00' };
  const pendingWrites = new Set<string>();
  const holdResponse = (path: string) => {
    pendingWrites.add(path);
    return slowRetry;
  };
  let sold = false;
  let paid = false;

  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  await page.clock.setFixedTime(new Date(date + 'T14:00:00Z'));
  await page.route('**/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && failOnce.delete(path)) return route.abort('connectionreset');
    if (req.method() === 'POST' && path === firstPath + '/coupons') {
      expect(req.postDataJSON()).toMatchObject({ code: coupon.code, version: first.version });
      await holdResponse(path);
      first.discountGrosze = coupon.discountGrosze;
      first.version++;
      return route.fulfill({ json: first });
    }
    if (req.method() === 'POST' && path === firstPath + '/products') {
      expect(req.postDataJSON()).toEqual({ productId: product.id, quantity: 1 });
      await holdResponse(path);
      sold = true;
      return route.fulfill({ json: { sales: [sale], totalGrosze: sale.totalGrosze } });
    }
    if (req.method() === 'POST' && path === redeem) {
      expect(req.postDataJSON()).toMatchObject({ appointmentId: first.id, amountGrosze: 1250 });
      await holdResponse(path);
      paid = true;
      return route.fulfill({ json: { voucher: { balanceGrosze: 3750 } } });
    }
    const replies: Record<string, unknown> = {
      '/v1/auth/refresh': { accessToken: 'test' },
      '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner' }] },
      '/v1/organizations/org/locations': [location],
      '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
      [base + '/staff']: [],
      [base + '/calendar']: { from: date, location, staff: [], appointments: [first, second] },
      [base + '/waitlist']: { items: [] },
      [base + '/products']: { products: [product], sold30Days: [] },
      [base + '/gift-vouchers/code/ABCD1234']: { voucher: { id: 'voucher' } },
    };
    for (const visit of [first, second]) {
      const visitPath = base + '/appointments/' + visit.id;
      replies[visitPath] = visit;
      replies[visitPath + '/photos'] = { items: [] };
      replies[visitPath + '/reservations'] = { reservations: [], toHandGrosze: 0 };
      replies[visitPath + '/coupons'] = {
        tier: null,
        applied: visit.discountGrosze ? [coupon] : [],
        available: visit.discountGrosze ? [] : [coupon],
      };
      replies[visitPath + '/products'] = {
        sales: visit === first && sold ? [sale] : [],
        totalGrosze: visit === first && sold ? sale.totalGrosze : 0,
      };
      replies[visitPath + '/gift-voucher-payments'] = {
        payments: visit === first && paid ? [payment] : [],
        totalGrosze: visit === first && paid ? payment.amountGrosze : 0,
      };
    }
    return path in replies
      ? route.fulfill({ json: replies[path] })
      : route.fulfill({ status: 404 });
  });
  return pendingWrites;
}

function visitForms(page: Page) {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const vouchers = page.getByTestId('visit-vouchers');
  return {
    button,
    back: button(pl.visit.back),
    openVisit: (name: string) =>
      page.getByRole('button', { name: name + ' · Strzyżenie' }).press('Enter'),
    vouchers,
    openVoucher: button(pl.vouchers.visitOpen),
    couponCode: page.getByRole('textbox', { name: pl.visit.coupons.code, exact: true }),
    voucherCode: vouchers.getByLabel(pl.vouchers.code, { exact: true }),
    amount: vouchers.getByLabel(pl.vouchers.payAmount, { exact: true }),
    barcode: page.getByLabel(pl.products.saleByCode, { exact: true }),
    applyCoupon: button(pl.visit.coupons.useCode),
    pay: button(pl.vouchers.pay),
    sell: button(pl.products.addByCode),
  };
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test('visit code drafts survive failed writes and navigation, and clear after use or cancellation', async ({
  page,
}) => {
  const app = await serveApp('mobile-business');
  let release!: () => void;
  const writeResponses = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const pendingWrites = await mockSalon(page, writeResponses);
    await page.goto(app.url);
    const forms = visitForms(page);

    await test.step('failed writes keep the original input', async () => {
      await forms.openVisit('Ewa');
      await forms.couponCode.fill('dm25');
      await forms.applyCoupon.click();
      await expect(forms.couponCode).toHaveAccessibleDescription('! ' + pl.error.network);
      await forms.openVoucher.click();
      await forms.voucherCode.fill('abcd-1234');
      await forms.amount.fill('12,50');
      await forms.pay.click();
      await expect(forms.amount).toHaveAccessibleDescription('! ' + pl.error.network);
      await forms.barcode.fill('dm1234');
      await forms.sell.click();
      await expect(forms.barcode).toHaveAccessibleDescription('! ' + pl.error.network);
      await forms.back.click();
    });

    await test.step('a different visit starts with its own defaults', async () => {
      await forms.openVisit('Jan');
      await forms.openVoucher.click();
      await expect(forms.couponCode).toHaveValue('');
      await expect(forms.barcode).toHaveValue('');
      await expect(forms.voucherCode).toHaveValue('');
      await expect(forms.amount).toHaveValue('60');
      await forms.back.click();
    });

    await test.step('returning restores only the typed values for retry', async () => {
      await forms.openVisit('Ewa');
      await forms.openVoucher.click();
      await expect(forms.couponCode).toHaveValue('dm25');
      await expect(forms.voucherCode).toHaveValue('abcd-1234');
      await expect(forms.amount).toHaveValue('12,50');
      await expect(forms.barcode).toHaveValue('dm1234');
      for (const field of [forms.couponCode, forms.amount, forms.barcode]) {
        await expect(field).not.toHaveAttribute('aria-invalid', 'true');
      }
      await forms.applyCoupon.click();
      await forms.pay.click();
      await forms.sell.click();
      await expect.poll(() => pendingWrites.size).toBe(3);
      await forms.back.click();
    });

    await test.step('the reopened visit receives the pending writes and clears the used inputs', async () => {
      await forms.openVisit('Ewa');
      await expect(page.getByTestId('tip-field')).toBeVisible();
      release();
      await expect(
        forms.button(fill(pl.visit.coupons.removeOne, { code: coupon.code })),
      ).toBeVisible();
      await expect(
        forms.button(fill(pl.products.removeSaleFor, { name: product.name })),
      ).toBeVisible();
      await expect(forms.vouchers.getByTestId('visit-voucher-left')).toContainText('62,50');
      await expect(forms.couponCode).toHaveValue('');
      await expect(forms.barcode).toHaveValue('');
      await forms.openVoucher.click();
      await expect(forms.voucherCode).toHaveValue('');
      await expect(forms.amount).toHaveValue('62,50');
      await forms.back.click();
    });

    await test.step('successful writes and explicit cancellation start a fresh draft', async () => {
      await forms.openVisit('Ewa');
      await forms.openVoucher.click();
      await expect(forms.couponCode).toHaveValue('');
      await expect(forms.barcode).toHaveValue('');
      await expect(forms.voucherCode).toHaveValue('');
      await expect(forms.amount).toHaveValue('62,50');
      await forms.voucherCode.fill('CANCEL');
      await forms.amount.fill('3');
      await forms.vouchers.getByRole('button', { name: pl.clients.cancel, exact: true }).click();
      await forms.back.click();
      await forms.openVisit('Ewa');
      await forms.openVoucher.click();
      await expect(forms.voucherCode).toHaveValue('');
      await expect(forms.amount).toHaveValue('62,50');
    });
  } finally {
    release();
    app.server.close();
  }
});

test('applying each code on the open visit resets only its own form', async ({ page }) => {
  const app = await serveApp('mobile-business');
  try {
    await mockSalon(page);
    await page.goto(app.url);
    const forms = visitForms(page);
    await forms.openVisit('Ewa');
    await forms.openVoucher.click();
    await forms.couponCode.fill('dm25');
    await forms.voucherCode.fill('abcd-1234');
    await forms.amount.fill('12,50');
    await forms.barcode.fill('dm1234');

    await forms.applyCoupon.click();
    await expect(forms.couponCode).toHaveValue('');
    await expect(forms.amount).toHaveValue('12,50');
    await forms.pay.click();
    await expect(forms.vouchers.getByTestId('visit-voucher-left')).toContainText('62,50');
    await forms.openVoucher.click();
    await expect(forms.voucherCode).toHaveValue('');
    await expect(forms.amount).toHaveValue('62,50');
    await expect(forms.barcode).toHaveValue('dm1234');
    await forms.sell.click();
    await expect(forms.barcode).toHaveValue('');
    await expect(
      forms.button(fill(pl.products.removeSaleFor, { name: product.name })),
    ).toBeVisible();
  } finally {
    app.server.close();
  }
});
