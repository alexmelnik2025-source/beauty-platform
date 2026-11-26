import { expect, test, type Page } from '@playwright/test';
import type { GiftVoucher } from '../../mobile-business/src/api';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { expandBusinessRow, openBusinessMenu, serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

const locations = ['Mokotów', 'Wola'].map((name, index) => ({
  id: `salon-${index}`,
  name,
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
}));
const base = '**/v1/organizations/dj/locations/*';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'dj-session'),
  );
  await page.route('**/v1/**', (route) => route.abort());
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({ json: { accessToken: 'dj-access', refreshToken: 'dj-session' } }),
  );
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'owner' },
        organizations: [{ id: 'dj', name: 'Studio', role: 'owner' }],
      },
    }),
  );
  await page.route('**/v1/organizations/dj/locations', (route) =>
    route.fulfill({ json: locations }),
  );
  await page.route(base + '/staff', (route) =>
    route.fulfill({
      json: [{ id: 'anna', userId: 'owner', displayName: 'Anna', active: true, sortOrder: 0 }],
    }),
  );
  await page.route(base + '/services', (route) => route.fulfill({ json: [] }));
  await page.goto(app.url);
  await button(page, 'Mokotów').click();
});

test('service drafts keep typed fields across navigation and reset on save or cancel', async ({
  page,
}) => {
  const s = pl.services;
  const name = field(page, s.name);
  const price = field(page, fill(s.price, { currency: 'PLN' }));
  const service = {
    id: 'cut',
    name: 'Strzyżenie',
    priceGrosze: 8000,
    durationMinutes: 30,
    active: true,
    categoryId: null,
    staffIds: [],
    sortOrder: 0,
    version: 1,
    description: null,
    bufferMinutes: 0,
    color: null,
    wishPhotos: false,
  };
  const services = [service];
  await page.route(base + '/service-categories', (route) => route.fulfill({ json: [] }));
  await page.route(base + '/staff-prices', (route) =>
    route.fulfill({ json: { prices: [], durations: [] } }),
  );
  await page.route(base + '/services', (route) => {
    if (route.request().method() === 'POST') {
      const created = { ...service, ...route.request().postDataJSON(), id: 'new' };
      services.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ json: services });
  });

  await openBusinessMenu(page, s.open);
  await expandBusinessRow(page, service.name);
  await button(page, `${s.edit}: ${service.name}`).click();
  await expect(price).toHaveValue('80');
  await name.fill('Strzyżenie damskie');
  await button(page, s.back).click();
  // Another user changes a field that was left untouched in the draft.
  service.priceGrosze = 9500;
  service.version++;
  await button(page, s.open).click();
  await expect(name).toHaveValue('Strzyżenie damskie');
  await expect(price).toHaveValue('95');
  await button(page, s.cancel).click();
  await button(page, s.back).click();
  await button(page, s.open).click();
  await expect(button(page, s.addService)).toBeVisible();
  await expect(name).toHaveCount(0);
  await expandBusinessRow(page, service.name);
  await button(page, `${s.edit}: ${service.name}`).click();
  await expect(name).toHaveValue(service.name);
  await button(page, s.cancel).click();

  await button(page, s.addService).click();
  await name.fill('Golenie');
  await price.fill('45');
  await button(page, s.back).click();
  await button(page, s.open).click();
  await expect(name).toHaveValue('Golenie');
  await expect(price).toHaveValue('45');
  await button(page, s.save).click();
  await expect(page.getByText(fill(s.copied, { name: 'Golenie' }))).toBeVisible();
  expect(services[1]).toMatchObject({ name: 'Golenie', priceGrosze: 4500 });
  await button(page, s.back).click();
  await button(page, s.open).click();
  await button(page, s.addService).click();
  await expect(name).toHaveValue('');
  await expect(price).toHaveValue('');
  await expect(field(page, s.duration)).toHaveValue('30');
});

test('a voucher lookup refreshes on return and the next salon starts without drafts', async ({
  page,
}) => {
  const v = pl.vouchers;
  const voucher: GiftVoucher = {
    id: 'gift',
    code: 'ABCD1234',
    amountGrosze: 10000,
    balanceGrosze: 10000,
    validUntil: null,
    recipient: null,
    note: 'Pierwsza notatka',
    status: 'active',
    soldDate: '2026-11-23',
    paymentMethod: null,
    soldByName: null,
    cancelledAt: null,
  };
  const collection = '**/v1/organizations/dj/locations/salon-0/gift-vouchers';
  const lookup = collection + '/code/' + voucher.code;
  const vouchers = [voucher];
  const totals = (items: GiftVoucher[]) => ({
    vouchers: items,
    activeBalanceGrosze: items.reduce((total, item) => total + item.balanceGrosze, 0),
    expiringSoon: { count: 0, balanceGrosze: 0, until: '2026-12-23' },
  });
  await page.route(collection, (route) => {
    if (route.request().method() === 'POST') {
      const sale = route.request().postDataJSON();
      const sold = {
        ...voucher,
        ...sale,
        id: 'sold',
        code: 'EFGH5678',
        balanceGrosze: sale.amountGrosze,
      };
      vouchers.push(sold);
      return route.fulfill({ status: 201, json: sold });
    }
    return route.fulfill({ json: totals(vouchers) });
  });
  await page.route('**/v1/organizations/dj/locations/salon-1/gift-vouchers', (route) =>
    route.fulfill({ json: totals([]) }),
  );
  await page.route(lookup, (route) => route.fulfill({ json: { voucher, uses: [] } }));
  await openBusinessMenu(page, v.open);
  await field(page, v.amount).fill('75');
  await field(page, v.code).fill(voucher.code);
  await button(page, v.check).click();
  await expect(page.getByText('Pierwsza notatka', { exact: true })).toBeVisible();
  await button(page, v.back).click();
  voucher.balanceGrosze = 4000;
  voucher.note = 'Nowa notatka';
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(lookup, async (route) => {
    await pending;
    await route.fallback();
  });
  try {
    await Promise.all([page.waitForRequest(lookup), button(page, v.open).click()]);
    await expect(field(page, v.code)).toHaveValue(voucher.code);
    await expect(field(page, v.amount)).toHaveValue('75');
    await expect(page.getByText('Pierwsza notatka', { exact: true })).toHaveCount(0);
    await expect(field(page, v.payAmount)).toHaveCount(0);
  } finally {
    release();
  }
  const details = page.getByText('Nowa notatka', { exact: true }).locator('..');
  await expect(details).toContainText(/Zostało 40,00\s*zł z 100,00\s*zł/);
  await field(page, v.recipient).fill('Basia');
  await button(page, v.sell).click();
  await expect(page.getByText(fill(v.sold, { code: 'EFGH5678' }))).toBeVisible();
  expect(vouchers[1]).toMatchObject({ amountGrosze: 7500, recipient: 'Basia' });
  await button(page, v.back).click();
  await button(page, v.open).click();
  await expect(field(page, v.amount)).toHaveValue('');
  await expect(field(page, v.recipient)).toHaveValue('');
  await expect(field(page, v.code)).toHaveValue(voucher.code);
  await expect(details).toContainText(/Zostało 40,00\s*zł z 100,00\s*zł/);
  await field(page, v.amount).fill('90');
  await button(page, v.back).click();
  await button(page, pl.changeSalon).click();
  await button(page, 'Wola').click();
  await openBusinessMenu(page, v.open);
  await expect(field(page, v.code)).toHaveValue('');
  await expect(field(page, v.amount)).toHaveValue('');
  await expect(field(page, v.payAmount)).toHaveCount(0);
});

test('a weekly schedule draft preserves edited days and saves fresh hours for untouched days', async ({
  page,
}) => {
  const s = pl.schedule;
  const monday = field(page, 'poniedziałek');
  const tuesday = field(page, 'wtorek');
  const day = (weekday: number, start: string) => ({
    weekday,
    intervals: [{ start, end: '17:00' }],
  });
  let weekly = [day(1, '09:00'), day(2, '09:00')];
  await page.route(base + '/staff/anna/time-off', (route) => route.fulfill({ json: [] }));
  await page.route(base + '/staff/anna/working-hours', (route) => {
    if (route.request().method() === 'PUT') weekly = route.request().postDataJSON().days;
    return route.fulfill({ json: { timezone: 'Europe/Warsaw', weekly, overrides: [] } });
  });
  await openBusinessMenu(page, s.open);
  await button(page, s.editWeek).click();
  await monday.fill('08:00–17:00');
  await button(page, s.back).click();
  weekly[1] = day(2, '10:00');
  await button(page, s.open).click();
  await expect(monday).toHaveValue('08:00–17:00');
  await expect(tuesday).toHaveValue('10:00–17:00');
  await button(page, s.saveWeek).click();
  await expect(page.getByText(s.weekSaved)).toBeVisible();
  expect(weekly).toEqual([day(1, '08:00'), day(2, '10:00')]);
  weekly[0] = day(1, '07:00');
  await button(page, s.back).click();
  await button(page, s.open).click();
  await button(page, s.editWeek).click();
  await expect(monday).toHaveValue('07:00–17:00');
});

test('removing another promotion keeps the open draft and cancelling it resets the fields', async ({
  page,
}) => {
  const h = pl.happyHours;
  const existing = {
    id: 'offer',
    kind: 'lastMinute',
    lastMinuteHours: 4,
    discountPercent: 10,
    weekdays: [],
    start: null,
    end: null,
    staffIds: [],
    serviceIds: [],
  };
  let rules = [existing];
  await page.route(base + '/happy-hours', (route) => {
    if (route.request().method() === 'PUT') rules = route.request().postDataJSON().rules;
    return route.fulfill({ json: { rules } });
  });
  await openBusinessMenu(page, h.open);
  await button(page, h.add).click();
  await button(page, h.lastMinute).click();
  await field(page, h.lastMinuteHours).fill('12');
  await field(page, h.percent).fill('20');
  await button(page, h.back).click();
  await button(page, h.open).click();
  const summary = fill(h.lastMinuteSummary, { hours: '4' });
  await button(page, fill(h.removeOne, { what: summary })).click();
  await button(page, h.removeYes).click();
  await expect(page.getByText(h.removed)).toBeVisible();
  expect(rules).toEqual([]);
  await expect(field(page, h.lastMinuteHours)).toHaveValue('12');
  await expect(field(page, h.percent)).toHaveValue('20');
  await button(page, h.cancel).click();
  await button(page, h.back).click();
  await button(page, h.open).click();
  await button(page, h.add).click();
  await button(page, h.lastMinute).click();
  await expect(field(page, h.lastMinuteHours)).toHaveValue('');
  await expect(field(page, h.percent)).toHaveValue('');
});
