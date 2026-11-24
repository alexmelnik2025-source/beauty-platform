import { expect, test, type Page, type Route } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const salon = {
  name: 'Studio CT',
  slug: 'studio-ct',
  timezone: 'Europe/Warsaw',
  addressLine: 'Jasna 1',
  city: 'Warszawa',
  postalCode: '00-001',
  phone: null,
  currency: 'PLN',
  languages: [],
};
const hours = [{ start: '09:00', end: '18:00' }];
const base = '**/v1/public/locations/' + salon.slug;
const items = Array.from({ length: 20 }, (_, i) => ({
  id: String(i + 1),
  createdAt: '2026-11-23T10:00:00Z',
  rating: 5,
  text: 'Opinia ' + (i + 1),
  staffName: 'Kasia',
  serviceName: 'Classic',
}));
const first = {
  enabled: true,
  count: 21,
  average: 5,
  stars: [0, 0, 0, 0, 21],
  staff: [],
  items,
  nextBefore: '20',
};

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });
let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

async function mockSalon(page: Page) {
  await page.route('**/v1/public/locations?**', (route) =>
    route.fulfill({
      json: {
        items: [
          { ...salon, todayHours: hours, distanceKm: null, rating: null, priceFromGrosze: null },
        ],
        total: 1,
        page: 1,
        pageCount: 1,
        openNowCount: 1,
        specialtyCounts: {},
        languageCounts: {},
      },
    }),
  );
  await page.route(base, (route) =>
    route.fulfill({
      json: {
        ...salon,
        todayHours: { date: '2026-11-24', intervals: hours },
        openingHours: [],
        services: [],
        categories: [],
        photos: [],
        staff: [],
      },
    }),
  );
  await page.route(base + '/free-today', (route) => route.fulfill({ json: { staffIds: [] } }));
}

test('salon reuses review pages and one voucher lookup handles repeated submits', async ({
  page,
}) => {
  const requests: string[] = [];
  await page.clock.setFixedTime(new Date('2026-11-24T15:00:00Z'));
  await mockSalon(page);
  await page.route(base + '/reviews*', (route) => {
    const query = new URL(route.request().url()).search;
    requests.push('reviews' + query);
    return route.fulfill({
      json:
        query === '?before=20'
          ? {
              ...first,
              items: [{ ...items[0], id: '21', text: 'Ostatnia opinia' }],
              nextBefore: null,
            }
          : first,
    });
  });
  let hold!: (route: Route) => void;
  const voucher = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  await page.route(base + '/gift-vouchers/*', (route) => {
    requests.push('voucher');
    hold(route);
  });
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await page.goto(app.url);
  await button(t.catalog.searchGo).click();
  const card = page.getByRole('article', { name: salon.name });
  const status = card.getByRole('status');
  await expect(status).toHaveAccessibleName(/18:00/);
  await button(t.catalog.filterKind).click();
  await button(t.catalog.filterKind).click();
  await expect(status).toHaveAccessibleName(/18:00/);
  await page.clock.setFixedTime(new Date('2026-11-24T17:01:00Z'));
  await button(t.catalog.filterKind).click();
  await expect(status).toHaveAccessibleName(t.salon.closedNow);
  const open = card.getByRole('button', { name: t.catalog.open });
  await open.click();
  const reviews = page.getByRole('region', { name: t.salonReviews.title });
  const firstRow = reviews.getByText('Opinia 1', { exact: true });
  const lastRow = reviews.getByText('Ostatnia opinia');
  const more = reviews.getByRole('button', { name: t.salonReviews.more });
  await expect(firstRow).toBeVisible();
  await more.click();
  await expect(lastRow).toBeVisible();
  await expect(reviews.getByRole('img')).toHaveCount(22);
  await button(t.salon.about + ' ▸').click();
  await button(t.salon.qrShow).click();
  const qr = page.getByRole('img', { name: t.salon.qrAlt });
  await expect(qr).toBeVisible();
  await button(t.salon.qrHide).click();
  await expect(qr).toHaveCount(0);
  await button(t.salon.qrShow).click();
  await expect(qr).toBeVisible();
  await button(t.voucherCheck.open).click();
  const code = page.getByRole('textbox', { name: t.voucherCheck.code });
  await code.pressSequentially('CT1234');
  await button(t.voucherCheck.check).dblclick();
  await code.press('Enter');
  await expect(button(t.voucherCheck.check)).toBeDisabled();
  await (
    await voucher
  ).fulfill({
    json: {
      status: 'active',
      currency: 'PLN',
      balanceGrosze: 1500,
      amountGrosze: 5000,
      validUntil: null,
    },
  });
  await expect(
    page.getByRole('status').filter({ hasText: t.voucherCheck.payAtSalon }),
  ).toContainText(/15,00/);
  await expect(qr).toBeVisible();
  await button(t.salon.back).click();
  await open.click();
  await expect(firstRow).toBeVisible();
  await more.click();
  await expect(lastRow).toBeVisible();
  expect(requests).toEqual(['reviews', 'reviews?before=20', 'voucher']);
});

function reply(page: Page, url: string, json: unknown) {
  return page.route(url, (route) => route.fulfill({ json }));
}

async function mockVisit(page: Page, status: 'cancelled' | 'completed') {
  const visit = {
    id: 'visit',
    salon,
    status,
    date: '2026-11-20',
    time: '12:00',
    start: '2026-11-20T11:00:00Z',
    end: '2026-11-20T11:30:00Z',
    timezone: salon.timezone,
    currency: salon.currency,
    service: { id: 'cut', name: 'Classic', durationMinutes: 30, priceGrosze: 8000 },
    staff: { id: 'alex', displayName: 'Alex' },
    canChange: false,
    awaitingApproval: false,
    wishes: { mood: null, drink: null, note: null },
    wishQuestions: { mood: false, drinks: [], note: false },
    canChangeWishes: false,
    bookAgain: { slug: salon.slug, serviceId: 'cut', staffId: 'alex' },
    coupons: [],
    discountGrosze: 0,
  };
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await reply(page, '**/v1/client/me', { email: 'client@example.test', locale: 'pl' });
  await reply(page, '**/v1/client/me/summary', {
    completed: 0,
    salons: 0,
    firstVisitAt: null,
    spent: [],
  });
  await reply(page, '**/v1/client/waitlist', { items: [] });
  await reply(page, '**/v1/client/appointments?scope=upcoming', { items: [] });
  await reply(page, '**/v1/client/appointments?scope=past', { items: [visit] });
  const detail = '**/v1/client/appointments/visit';
  await reply(page, detail, visit);
  await reply(page, detail + '/photos', { items: [], deleteAfter: null });
  return detail;
}

test('cancelled visit reuses reserved products on return', async ({ page }) => {
  const detail = await mockVisit(page, 'cancelled');
  let attempts = 0;
  await page.route(detail + '/products', (route) => {
    attempts++;
    return route.fulfill({
      json: {
        currency: 'PLN',
        reservations: [
          {
            id: 'r1',
            productId: 'pomade',
            name: 'Pomada',
            quantity: 1,
            totalGrosze: 5900,
            status: 'reserved',
          },
        ],
      },
    });
  });
  await page.goto(app.url);
  await page.getByRole('tab', { name: t.visits.past, exact: true }).click();
  await page.getByRole('button', { name: '12:00 Classic, ' + salon.name }).click();
  const products = page.getByRole('region', { name: t.visitProducts.moveTitle });
  await expect(products.getByText('Pomada')).toBeVisible();
  await expect(products.getByRole('button', { name: t.visitProducts.moveBook })).toBeEnabled();
  await page.getByRole('button', { name: t.visit.back }).click();
  await page.getByRole('tab', { name: t.visits.past, exact: true }).click();
  await page.getByRole('button', { name: '12:00 Classic, ' + salon.name }).click();
  await expect(products.getByText('Pomada')).toBeVisible();
  expect(attempts).toBe(1);
});

test('leaving the salon aborts pending reviews and voucher balance', async ({ page }) => {
  // Chromium can keep a paused Playwright route open after the page's fetch has rejected.
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      try {
        return await fetch(...args);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          const path = new URL(String(args[0]), location.href).pathname;
          document.documentElement.dataset.aborted =
            (document.documentElement.dataset.aborted ?? '') + path + '\n';
        }
        throw error;
      }
    };
  });
  await mockSalon(page);
  const reviewsUrl = base + '/reviews';
  const voucherUrl = base + '/gift-vouchers/CT1234';
  await page.route(reviewsUrl, () => {});
  await page.route(voucherUrl, () => {});
  await page.goto(app.url);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await button(t.catalog.searchGo).click();
  const open = page
    .getByRole('article', { name: salon.name })
    .getByRole('button', { name: t.catalog.open });
  const pendingReviews = page.waitForRequest(reviewsUrl);
  await open.click();
  await pendingReviews;
  await button(t.voucherCheck.open).click();
  await page.getByRole('textbox', { name: t.voucherCheck.code }).fill('CT1234');
  const pendingVoucher = page.waitForRequest(voucherUrl);
  await button(t.voucherCheck.check).click();
  await pendingVoucher;
  await button(t.salon.back).click();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-aborted', /\/studio-ct\/reviews\n/);
  await expect(html).toHaveAttribute('data-aborted', /\/studio-ct\/gift-vouchers\/CT1234\n/);
  await reply(page, reviewsUrl, first);
  await open.click();
  await expect(page.getByText('Opinia 1', { exact: true })).toBeVisible();
});

test('reopening a completed visit keeps the saved review', async ({ page }) => {
  const detail = await mockVisit(page, 'completed');
  await reply(page, detail + '/products', { available: [], reservations: [], totalGrosze: 0 });
  await reply(page, detail + '/products/used', { products: [] });
  const methods: string[] = [];
  const words = 'Dziękuję za strzyżenie!';
  let hold!: (route: Route) => void;
  const saving = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  await page.route(detail + '/review', (route) => {
    const method = route.request().method();
    methods.push(method);
    if (method === 'PUT') return hold(route);
    return route.fulfill({ json: { canReview: true, review: null } });
  });
  await page.goto(app.url);
  const past = page.getByRole('tab', { name: t.visits.past, exact: true });
  const open = page.getByRole('button', { name: '12:00 Classic, ' + salon.name });
  await past.click();
  await open.click();
  const review = page.getByRole('region', { name: t.review.title });
  await review.getByRole('radio', { name: '4 z 5' }).click();
  await review.getByRole('textbox', { name: t.review.text }).fill(words);
  await review.getByRole('button', { name: t.review.send }).click();
  const write = await saving;
  await page.getByRole('button', { name: t.visit.back }).click();
  await past.click();
  await open.click();
  await expect(page.getByRole('button', { name: t.visit.back })).toBeVisible();
  await write.fulfill({ json: { canReview: true, review: { rating: 4, text: words } } });
  await expect(review.getByText(words)).toBeVisible();
  await page.getByRole('button', { name: t.visit.back }).click();
  await past.click();
  await open.click();
  await expect(review.getByText(words)).toBeVisible();
  expect(methods).toEqual(['GET', 'PUT']);
});

test('a late product list cannot replace the reopened visit', async ({ page }) => {
  const detail = await mockVisit(page, 'cancelled');
  const list = (name: string) => ({
    currency: 'PLN',
    reservations: [
      { id: 'r1', productId: 'r1', name, quantity: 1, totalGrosze: 1500, status: 'reserved' },
    ],
  });
  let hold!: (route: Route) => void;
  const delayed = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  let reads = 0;
  await page.route(detail + '/products', (route) => {
    if (++reads === 1) return hold(route);
    return route.fulfill({ json: list('Nowa pomada') });
  });
  await page.goto(app.url);
  const past = page.getByRole('tab', { name: t.visits.past, exact: true });
  const open = page.getByRole('button', { name: '12:00 Classic, ' + salon.name });
  await past.click();
  await open.click();
  const old = await delayed;
  await page.getByRole('button', { name: t.visit.back }).click();
  await past.click();
  await open.click();
  const products = page.getByRole('region', { name: t.visitProducts.moveTitle });
  await expect(products.getByText('Nowa pomada')).toBeVisible();
  const settled = page.waitForResponse((response) => response.request() === old.request());
  await old.fulfill({ json: list('Stara pomada') });
  await (await settled).finished();
  await expect(products.getByText('Stara pomada')).toHaveCount(0);
  await expect(products.getByText('Nowa pomada')).toBeVisible();
  expect(reads).toBe(2);
});
