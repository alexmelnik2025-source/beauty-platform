import { expect, test, type Page } from '@playwright/test';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const date = '2026-11-24';
const location = { id: 'salon', name: 'Salon CR', timezone: 'Europe/Warsaw', currency: 'PLN' };
const base = '/v1/organizations/org/locations/salon';
const path = base + '/appointments/visit';
const product = {
  id: 'cream',
  name: 'Krem',
  active: true,
  supplier: null,
  priceGrosze: 2500,
  stockQuantity: 5,
  barcode: 'CR1234',
};
const coupon = { id: 'coupon', name: 'Rabat', code: 'CR24', discountGrosze: 500, problem: null };
const reserved = {
  id: 'reserved',
  name: 'Szampon',
  quantity: 1,
  totalGrosze: 3500,
  status: 'reserved',
};
const catalogue = Array.from({ length: 20 }, (_, i) =>
  i === 0 ? product : { ...product, id: 'item-' + i, name: 'Produkt ' + i, barcode: null },
);
const sale = { id: 'sale', name: product.name, totalGrosze: 2500, quantity: 1 };

async function mockSalon(page: Page, status: 'confirmed' | 'completed') {
  let visit = {
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
    paidAt: null,
    tipGrosze: 0,
    durationMinutes: 30,
  };
  const reads = { coupons: 0, reservations: 0, sales: 0, catalogue: 0, vouchers: 0, waitlist: 0 };
  let sales = { sales: [] as (typeof sale)[], totalGrosze: 0 };
  const writes: string[] = [];
  const requests: string[] = [];
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  await page.clock.setFixedTime(new Date(date + 'T14:00:00Z'));
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url()).pathname;
    requests.push(url);
    if (url === path + '/status') {
      visit = { ...visit, version: visit.version + 1, status: 'completed' };
      return route.fulfill({ json: visit });
    }
    if (url === path + '/products' && route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON().productId);
      sales = { sales: [sale], totalGrosze: sale.totalGrosze };
      return route.fulfill({ json: sales });
    }
    const sections = {
      [path + '/coupons']: ['coupons', { tier: null, applied: [], available: [coupon] }],
      [path + '/reservations']: ['reservations', { reservations: [reserved], toHandGrosze: 3500 }],
      [path + '/products']: ['sales', sales],
      [base + '/products']: ['catalogue', { products: catalogue, sold30Days: [] }],
      [path + '/gift-voucher-payments']: ['vouchers', { payments: [], totalGrosze: 0 }],
      [base + '/waitlist']: ['waitlist', { items: [] }],
    } as const;
    const section = sections[url];
    if (section) {
      reads[section[0]]++;
      return route.fulfill({ json: section[1] });
    }
    const replies: Record<string, unknown> = {
      '/v1/auth/refresh': { accessToken: 'test' },
      '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner' }] },
      '/v1/organizations/org/locations': [location],
      '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
      [base + '/staff']: [],
      [base + '/calendar']: { from: date, location, staff: [], appointments: [visit] },
      [path]: visit,
      [path + '/photos']: { items: [] },
    };
    return url in replies ? route.fulfill({ json: replies[url] }) : route.fulfill({ status: 404 });
  });
  return { reads, writes, requests };
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test('status, barcode typing and reopening reuse visit section reads', async ({ page }) => {
  const app = await serveApp('mobile-business');
  try {
    const { reads, requests } = await mockSalon(page, 'confirmed');
    const open = page.getByRole('button', { name: /Ewa · Strzyżenie/ });
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: pl.waitlist.title + ' (0)' })).toBeVisible();
    await open.click();
    await expect(page.getByTestId('visit-to-hand')).toBeVisible();
    await expect(
      page.getByRole('button', { name: fill(pl.visit.coupons.useOne, { code: coupon.code }) }),
    ).toBeVisible();
    await page.getByRole('button', { name: pl.visit.markCame, exact: true }).click();
    const code = page.getByTestId('visit-products-code');
    await expect(code).toBeVisible();
    await expect(page.getByTestId('visit-vouchers')).toBeVisible();
    await page.getByTestId('tip-field').getByRole('textbox').pressSequentially('123');
    const beforeTyping = requests.length;
    await code.pressSequentially(product.barcode);
    expect(requests.slice(beforeTyping)).toEqual([]);
    await expect(code).toHaveValue(product.barcode);
    await page.getByRole('button', { name: pl.visit.back, exact: true }).click();
    await expect(page.getByRole('heading', { name: pl.waitlist.title + ' (0)' })).toBeVisible();
    await open.click();
    await expect(code).toBeVisible();
    await expect(page.getByTestId('visit-to-hand')).toBeVisible();
    await expect(page.getByTestId('visit-vouchers')).toBeVisible();
    await expect(
      page.getByRole('button', { name: fill(pl.visit.coupons.useOne, { code: coupon.code }) }),
    ).toBeVisible();
    await page.getByRole('button', { name: pl.visit.back, exact: true }).click();
    await expect(page.getByRole('heading', { name: pl.waitlist.title + ' (0)' })).toBeVisible();
    // The attendance write refreshed the day once. The second return was read-only.
    expect(reads).toEqual({
      coupons: 1,
      reservations: 1,
      sales: 1,
      catalogue: 1,
      vouchers: 1,
      waitlist: 2,
    });
  } finally {
    app.server.close();
  }
});

test('reopening checks for newly issued coupons and newly reserved products after an empty visit', async ({
  page,
}) => {
  const app = await serveApp('mobile-business');
  try {
    await mockSalon(page, 'confirmed');
    await page.route(
      '**' + path + '/coupons',
      (route) => route.fulfill({ json: { tier: null, applied: [], available: [] } }),
      { times: 1 },
    );
    await page.route(
      '**' + path + '/reservations',
      (route) => route.fulfill({ json: { reservations: [], toHandGrosze: 0 } }),
      { times: 1 },
    );
    await page.goto(app.url);
    const open = page.getByRole('button', { name: /Ewa · Strzyżenie/ });
    const firstReservationRead = page.waitForResponse('**' + path + '/reservations');
    await open.click();
    await (await firstReservationRead).finished();
    await expect(page.getByText(pl.clients.coupons + ' (0)')).toBeVisible();
    await expect(page.getByTestId('visit-to-hand')).toHaveCount(0);
    await page.getByRole('button', { name: pl.visit.back, exact: true }).click();
    await open.click();
    await expect(
      page.getByRole('button', { name: fill(pl.visit.coupons.useOne, { code: coupon.code }) }),
    ).toBeVisible();
    await expect(page.getByTestId('visit-to-hand')).toContainText(reserved.name);
  } finally {
    app.server.close();
  }
});

test('a specialist cannot mark products on another specialist visit without manage-all permission', async ({
  page,
}) => {
  const app = await serveApp('mobile-business');
  try {
    await mockSalon(page, 'confirmed');
    await page.route('**/v1/me', (route) =>
      route.fulfill({
        json: {
          user: { id: 'signed-in-staff' },
          organizations: [{ id: 'org', role: 'staff' }],
        },
      }),
    );
    await page.route('**/v1/organizations/org/permissions', (route) =>
      route.fulfill({
        json: {
          me: {
            role: 'staff',
            permissions: {
              changeOwnAppointments: true,
              manageAllAppointments: false,
              viewAllAppointments: true,
            },
          },
        },
      }),
    );
    await page.route('**' + base + '/staff', (route) =>
      route.fulfill({
        json: [
          {
            id: 'own-staff-profile',
            userId: 'signed-in-staff',
            displayName: 'Signed in specialist',
            active: true,
          },
        ],
      }),
    );
    await page.goto(app.url);
    await page.getByRole('button', { name: /Ewa · Strzyżenie/ }).click();
    await expect(page.getByTestId('visit-used-products')).toHaveCount(0);
  } finally {
    app.server.close();
  }
});

test('a late catalogue cannot replace the barcode list refreshed after handing over a reservation', async ({
  page,
}) => {
  const app = await serveApp('mobile-business');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const { writes } = await mockSalon(page, 'completed');
    await page.route(
      '**' + base + '/products',
      async (route) => {
        await gate;
        await route.fulfill({
          json: { products: [{ ...product, id: 'obsolete', name: 'Stary krem' }], sold30Days: [] },
        });
      },
      { times: 1 },
    );
    await page.route('**' + path + '/reservations/reserved/hand-over', (route) =>
      route.fulfill({
        json: { reservations: [{ ...reserved, status: 'handed' }], toHandGrosze: 0 },
      }),
    );
    await page.goto(app.url);
    const slow = page.waitForRequest('**' + base + '/products');
    await page.getByRole('button', { name: /Ewa · Strzyżenie/ }).click();
    await slow;
    await page
      .getByRole('button', { name: fill(pl.products.toHandGiveFor, { name: reserved.name }) })
      .click();
    const code = page.getByTestId('visit-products-code');
    await expect(code).toBeVisible();
    await code.pressSequentially(product.barcode);
    const late = page.waitForResponse('**' + base + '/products');
    release();
    await (await late).finished();
    await page.getByRole('button', { name: pl.products.addByCode, exact: true }).click();
    await expect(code).toHaveValue('');
    expect(writes).toEqual([product.id]);
    await expect(
      page.getByRole('button', { name: fill(pl.products.removeSaleFor, { name: product.name }) }),
    ).toBeVisible();
  } finally {
    release();
    app.server.close();
  }
});

test('delivery quantity editing updates the total for the selected products', async ({ page }) => {
  const app = await serveApp('mobile-business');
  try {
    await mockSalon(page, 'completed');
    await page.goto(app.url);
    await page.getByRole('tab', { name: 'Sklep', exact: true }).click();
    await page.getByRole('button', { name: 'Magazyn ▸', exact: true }).click();
    await page.getByRole('button', { name: 'Przyjmij dostawę', exact: true }).click();
    const box = page.getByTestId('delivery');
    const quantity = box.getByLabel('Przyszło — Krem');
    await expect(quantity).toBeVisible();
    await quantity.pressSequentially('123');
    await expect(box.getByRole('button', { name: 'Przyjmij dostawę (123 szt.)' })).toBeEnabled();
    await expect(box.getByLabel('Przyszło — Produkt 1', { exact: true })).toHaveValue('');
  } finally {
    app.server.close();
  }
});
