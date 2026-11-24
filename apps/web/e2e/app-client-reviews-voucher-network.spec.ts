import { expect, test, type Page, type Route } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const salon = {
  name: 'Studio Lilia',
  slug: 'studio-lilia',
  city: 'Warszawa',
  postalCode: '00-001',
  addressLine: 'Jasna 1',
  phone: null,
  currency: 'PLN',
  timezone: 'Europe/Warsaw',
  languages: [],
};
const base = '**/v1/public/locations/' + salon.slug;
const review = {
  id: 'first',
  rating: 5,
  text: 'Bardzo dobre cięcie.',
  createdAt: '2026-11-24T10:00:00Z',
  staffName: 'Kasia',
  serviceName: 'Strzyżenie',
};
const firstPage = {
  enabled: true,
  count: 2,
  average: 4.5,
  stars: [0, 0, 0, 1, 1],
  staff: [],
  items: [review],
  nextBefore: 'first',
};
function reply(page: Page, url: string, json: unknown) {
  return page.route(url, (route) => route.fulfill({ json }));
}
async function openSalon(page: Page) {
  const hours = [{ start: '00:00', end: '24:00' }];
  await reply(page, '**/v1/public/locations?**', {
    items: [{ ...salon, todayHours: hours, distanceKm: null, rating: null, priceFromGrosze: null }],
    total: 1,
    page: 1,
    pageCount: 1,
    openNowCount: 1,
    specialtyCounts: {},
    languageCounts: {},
  });
  await reply(page, base, {
    ...salon,
    todayHours: { date: '2026-11-24', intervals: hours },
    openingHours: [],
    services: [],
    categories: [],
    photos: [],
    staff: [],
  });
  await reply(page, base + '/free-today', { staffIds: [] });
  await page.goto(app.url);
  await page.getByRole('button', { name: t.catalog.searchGo, exact: true }).click();
  const card = page.getByRole('article', { name: salon.name });
  await expect(card.getByRole('status')).toHaveAccessibleName(t.salon.openUntilMidnight);
  await card.getByRole('button', { name: t.catalog.open }).click();
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });
let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

test('reviews recover from interrupted pages and reuse the first page on return', async ({
  page,
}) => {
  let initialRequests = 0;
  let moreRequests = 0;
  let hold!: (route: Route) => void;
  const delayed = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  await page.route(base + '/reviews', (route) => {
    if (++initialRequests === 1) hold(route);
    else return route.fulfill({ json: firstPage });
  });
  await page.route(base + '/reviews?before=first', (route) => {
    if (++moreRequests === 1) return route.abort();
    return route.fulfill({
      json: {
        ...firstPage,
        nextBefore: null,
        items: [{ ...review, id: 'second', rating: 4, text: 'Polecam salon.' }],
      },
    });
  });
  await page.route(base + '/reviews?rating=4', (route) => route.abort());
  await openSalon(page);
  const reviews = page.getByRole('region', { name: t.salonReviews.title });
  const busy = reviews.getByRole('progressbar');
  const error = reviews.getByRole('alert');
  const retry = reviews.getByRole('button', { name: t.retry });
  await expect(busy).toBeVisible();
  await (await delayed).abort();
  await expect(error).toHaveText(t.error.network);
  await expect(busy).toHaveCount(0);
  await retry.click();
  await expect(reviews.getByText(review.text)).toBeVisible();
  await reviews.getByRole('button', { name: t.salonReviews.more }).click();
  await expect(error).toHaveText(t.error.network);
  await expect(reviews.getByText(review.text)).toBeVisible();
  await retry.click();
  await expect(reviews.getByText('Polecam salon.')).toBeVisible();
  await expect(reviews.getByText(review.text)).toBeVisible();
  expect(moreRequests).toBe(2);
  await reviews.getByRole('radio', { name: '★ 4 (1)' }).click();
  await expect(error).toHaveText(t.error.network);
  await expect(reviews.getByText(review.text)).toBeVisible();
  await expect(reviews.getByText('Polecam salon.')).toBeVisible();

  await page.getByRole('button', { name: t.salon.back }).click();
  await page
    .getByRole('article', { name: salon.name })
    .getByRole('button', { name: t.catalog.open })
    .click();
  await expect(reviews.getByText(review.text)).toBeVisible();
  expect(initialRequests).toBe(2);
});

test('voucher submits once, keeps the balance after a disconnect and retries the same code', async ({
  page,
}) => {
  await reply(page, base + '/reviews', firstPage);
  let hold!: (route: Route) => void;
  const delayed = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  let requests = 0;
  await page.clock.install();
  const voucher = {
    status: 'active',
    currency: 'PLN',
    balanceGrosze: 1500,
    amountGrosze: 5000,
    validUntil: null,
  };
  await page.route(base + '/gift-vouchers/LILIA', (route) => {
    requests++;
    if (requests === 1) hold(route);
    else if (requests === 2) return route.fulfill({ json: voucher });
    else if (requests === 3) return route.abort();
    else return route.fulfill({ json: { ...voucher, balanceGrosze: 1000 } });
  });
  await openSalon(page);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await button(t.salon.about + ' ▸').click();
  await button(t.salon.qrShow).click();
  const qr = page.getByRole('img', { name: t.salon.qrAlt });
  await expect(qr).toBeVisible();
  await button(t.voucherCheck.open).click();
  const code = page.getByRole('textbox', { name: t.voucherCheck.code });
  const check = button(t.voucherCheck.check);
  await code.fill('LILIA');
  await check.dblclick();
  await code.press('Enter');
  await expect(check).toBeDisabled();
  const pending = await delayed;
  await page.clock.fastForward(31_000);
  await expect(code).toHaveAccessibleDescription(t.error.network);
  expect(requests).toBe(1);
  await button(t.retry).click();
  const balance = page.getByRole('status').filter({ hasText: t.voucherCheck.payAtSalon });
  await expect(balance).toContainText(/15,00/);
  await pending.fulfill({ json: { ...voucher, balanceGrosze: 0 } });

  await check.click();
  await expect(code).toHaveAccessibleDescription(t.error.network);
  await expect(code).toHaveValue('LILIA');
  await expect(balance).toContainText(/15,00/);
  await expect(qr).toBeVisible();
  await button(t.retry).click();
  await expect(balance).toContainText(/10,00/);
  expect(requests).toBe(4);
});

test('cancelled visit recovers its products after a disconnect', async ({ page }) => {
  const visit = {
    id: 'visit',
    salon,
    status: 'cancelled',
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
  let attempts = 0;
  await page.route(detail + '/products', (route) => {
    if (++attempts === 1) return route.abort();
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
  await expect(page.getByRole('alert')).toHaveText(t.error.network);
  await page.getByRole('button', { name: t.retry }).click();
  const products = page.getByRole('region', { name: t.visitProducts.moveTitle });
  await expect(products.getByText('Pomada')).toBeVisible();
  await expect(products.getByRole('button', { name: t.visitProducts.moveBook })).toBeEnabled();
  await expect(page.getByRole('button', { name: t.visit.bookAgain })).toHaveCount(0);
});
