import { expect, test, type Locator, type Page } from '@playwright/test';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const date = '2026-11-26';
const location = { id: 'salon', name: 'Salon DY', timezone: 'Europe/Warsaw', currency: 'PLN' };
const base = '/v1/organizations/org/locations/salon';
const visitPath = base + '/appointments/visit';
const coupons = visitPath + '/coupons';
const catalogue = base + '/products';
const sales = visitPath + '/products';
const vouchers = visitPath + '/gift-voucher-payments';
const coupon = { id: 'coupon', name: 'Rabat', code: 'DY26', discountGrosze: 500, problem: null };
const product = {
  id: 'cream',
  name: 'Krem',
  active: true,
  barcode: null,
  stockQuantity: 4,
  priceGrosze: 2500,
};

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

async function openVisit(page: Page, status: 'confirmed' | 'completed', failures: string[]) {
  const visit = {
    id: 'visit',
    version: 1,
    date,
    time: '12:00',
    start: date + 'T11:00:00Z',
    end: date + 'T11:30:00Z',
    status,
    service: { id: 'service', name: 'Strzyżenie' },
    staff: { id: 'staff', displayName: 'Anna' },
    customer: { id: 'customer', name: 'Ewa' },
    priceGrosze: 8000,
    discountGrosze: 0,
    paidAt: null,
    tipGrosze: 0,
    durationMinutes: 30,
  };
  const replies: Record<string, unknown> = {
    '/v1/auth/refresh': { accessToken: 'test' },
    '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner' }] },
    '/v1/organizations/org/locations': [location],
    '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
    [base + '/staff']: [],
    [base + '/calendar']: { from: date, location, staff: [], appointments: [visit] },
    [base + '/waitlist']: { items: [] },
    [visitPath]: visit,
    [visitPath + '/photos']: { items: [] },
    [visitPath + '/reservations']: { reservations: [], toHandGrosze: 0 },
    [coupons]: { tier: null, applied: [], available: [coupon] },
    [catalogue]: { products: [product], sold30Days: [] },
    [sales]: {
      sales: [{ id: 'sale', name: product.name, quantity: 2, totalGrosze: 5000 }],
      totalGrosze: 5000,
    },
    [vouchers]: {
      payments: [{ id: 'payment', code: 'ABCD1234', amountGrosze: 1250, time: '12:30' }],
      totalGrosze: 1250,
    },
  };
  const failOnce = new Set(failures);
  const reads = new Map<string, number>();
  const writes: string[] = [];
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  await page.clock.setFixedTime(new Date(date + 'T14:00:00Z'));
  await page.route('**/v1/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET') {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      if (failOnce.delete(path)) return route.abort('connectionreset');
    } else if (path.startsWith(base)) {
      writes.push(req.method() + ' ' + path);
      return route.fulfill({ status: 405 });
    }
    return path in replies
      ? route.fulfill({ json: replies[path] })
      : route.fulfill({ status: 404 });
  });
  await page.goto(app.url);
  const row = page.getByRole('button', { name: '12:00 Ewa · Strzyżenie', exact: true });
  const label = row.getByText('Ewa', { exact: true });
  const fontSize = () =>
    label.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  const normal = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
  await row.press('Enter');
  return { reads, writes };
}

const retry = (section: Locator, title: string) =>
  section.getByRole('button', { name: `${pl.day.refresh}: ${title}`, exact: true });

test('an unpaid confirmed visit can reload its coupon offers after the first read fails', async ({
  page,
}) => {
  const { reads, writes } = await openVisit(page, 'confirmed', [coupons]);
  const section = page.getByTestId('visit-coupons');
  await expect(section.getByRole('alert')).toHaveText(pl.error.network);
  await retry(section, pl.visit.coupons.title).click();
  await expect(
    page.getByRole('button', { name: fill(pl.visit.coupons.useOne, { code: coupon.code }) }),
  ).toBeVisible();
  expect(reads.get(coupons)).toBe(2);
  expect(reads.get(visitPath)).toBe(1);
  expect(writes).toEqual([]);
});

for (const [source, failedPath] of [
  ['catalogue', catalogue],
  ['sales history', sales],
] as const) {
  test(`completed visit retries its ${source} and voucher history independently`, async ({
    page,
  }) => {
    const { reads, writes } = await openVisit(page, 'completed', [failedPath, vouchers]);
    const products = page.getByTestId('visit-products');
    const payments = page.getByTestId('visit-vouchers');
    await expect(products.getByRole('alert')).toHaveText(pl.error.network);
    await expect(payments.getByRole('alert')).toHaveText(pl.error.network);
    await retry(products, pl.products.sold).click();
    await expect(products.getByText('Krem × 2', { exact: true })).toBeVisible();
    await expect(
      products.getByRole('button', { name: fill(pl.products.addSaleFor, { name: product.name }) }),
    ).toBeEnabled();
    await expect(products.getByRole('alert')).toHaveCount(0);
    expect(reads.get(vouchers)).toBe(1);
    await retry(payments, pl.vouchers.title).click();
    await expect(payments.getByTestId('visit-voucher-left')).toContainText('67,50');
    await expect(payments.getByRole('alert')).toHaveCount(0);
    expect(reads.get(vouchers)).toBe(2);
    expect(reads.get(failedPath)).toBe(2);
    expect(reads.get(failedPath === catalogue ? sales : catalogue)).toBe(1);
    expect(reads.get(coupons)).toBe(1);
    expect(reads.get(visitPath)).toBe(1);
    expect(writes).toEqual([]);
  });
}
