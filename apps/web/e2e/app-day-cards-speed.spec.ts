import { expect, test, type Page, type Route } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-business/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const date = '2026-11-24';
const base = '/v1/organizations/org/locations/salon';
const publicPath = '/v1/public/locations/salon';
const location = {
  id: 'salon',
  name: 'Studio CQ',
  city: 'Warszawa',
  slug: 'salon',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  onlineBookingEnabled: true,
};
const team = [{ id: 'anna', displayName: 'Anna', active: true, serviceIds: [] }];
const hours = (open: boolean) => ({
  timezone: location.timezone,
  openingHours: [],
  todayHours: { date, intervals: open ? [{ start: '00:00', end: '24:00' }] : [] },
});
const products = Array.from({ length: 24 }, (_, i) => ({
  id: String(i),
  name: `Pomada ${i}`,
  active: true,
  priceGrosze: 2500,
  stockQuantity: 8,
  supplier: null,
  lowStockAt: null,
  purchasePriceGrosze: null,
}));
let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

async function prepare(page: Page) {
  await page.clock.setFixedTime(new Date(date + 'T10:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  const reads = new Map<string, number>();
  await page.route('**/v1/**', (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    reads.set(pathname, (reads.get(pathname) ?? 0) + 1);
    const replies: Record<string, unknown> = {
      '/v1/auth/refresh': { accessToken: 'test' },
      '/v1/me': {
        user: { id: 'owner' },
        organizations: [{ id: 'org', role: 'owner', name: 'Studio CQ' }],
      },
      '/v1/organizations/org/locations': [location],
      '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
      '/v1/me/notifications/unread-count': { unread: 0 },
      [base]: location,
      [publicPath]: hours(true),
      [base + '/services']: [],
      [base + '/staff']: team,
      [base + '/calendar']: {
        from: searchParams.get('from'),
        location,
        staff: [],
        appointments: [],
      },
      [base + '/products']: { products, sold30Days: [] },
      [base + '/shop/integrations/base']: { connected: false },
    };
    return pathname in replies
      ? route.fulfill({ json: replies[pathname] })
      : route.fulfill({ status: 404 });
  });
  return (path: string) => reads.get(path) ?? 0;
}

// Use Chromium's function call counters in the exported app. The component creating
// each testID is the innermost function containing its string literal, even after minification.
async function renderCount(page: Page, testId: string) {
  const entries = await page.coverage.stopJSCoverage();
  const marker = JSON.stringify(testId);
  const entry = entries.find((e) => e.source?.includes(marker));
  expect(entry, testId).toBeDefined();
  const offset = entry!.source!.indexOf(marker);
  const component = entry!.functions
    .map((f) => f.ranges[0]!)
    .filter((r) => r.startOffset <= offset && r.endOffset > offset)
    .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset))[0];
  expect(component, testId).toBeDefined();
  return component!.count;
}

test('changing a day filter reuses the day cards', async ({ page }) => {
  const reads = await prepare(page);
  await page.goto(app.url);
  const current = page.getByTestId('clients-now');
  await expect(current.getByRole('heading')).toHaveAccessibleDescription(
    t.clientsNow.openUntilMidnight,
  );
  const setup = page.getByRole('group', { name: t.setup.title });
  await expect(setup.getByRole('button')).toBeVisible();
  const picker = page.getByRole('button', {
    name: `${t.navigation.specialist}: ${t.navigation.allStaff}`,
    exact: true,
  });
  const paths = [base, publicPath, base + '/services', base + '/staff'];
  const initial = paths.map(reads);
  await page.coverage.startJSCoverage();
  await picker.click();
  await picker.click();
  // Include one update inside the card as a positive control for the profiler.
  await current.getByRole('button').click();
  await expect(current.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  expect(await renderCount(page, 'clients-now')).toBe(1);
  await setup.getByRole('button', { name: `${t.navigation.more}: ${t.setup.title}` }).click();
  await expect(
    setup.getByRole('button', { name: `${t.navigation.more}: ${t.setup.title}` }),
  ).toHaveAttribute('aria-expanded', 'true');
  expect(paths.map(reads)).toEqual(initial);
});

test('returning to today discards the old pending hours', async ({ page }) => {
  await prepare(page);
  // Keep the returning calendar pending so its ordinary refresh cannot hide a stale card.
  let calendar: Route | undefined;
  let visitsToToday = 0;
  await page.route('**' + base + '/calendar?*', (route) => {
    if (new URL(route.request().url()).searchParams.get('from') === date && ++visitsToToday === 2) {
      calendar = route;
      return;
    }
    return route.fallback();
  });
  let first: Route | undefined;
  await page.route('**' + publicPath, (route) => {
    if (!first) {
      first = route;
      return;
    }
    return route.fulfill({ json: hours(false) });
  });
  await page.goto(app.url);
  await expect.poll(() => !!first).toBe(true);
  const card = page.getByTestId('clients-now');
  await page.getByRole('button', { name: t.day.next, exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: t.day.today, exact: true }).click();
  await expect(card.getByRole('heading')).toHaveAccessibleDescription(t.clientsNow.closedNow);
  const finished = page.waitForEvent('requestfinished', (r) => r === first!.request());
  await first!.fulfill({ json: hours(true) });
  await finished;
  await card.getByRole('button').click();
  await expect(card.getByRole('heading')).toHaveAccessibleDescription(t.clientsNow.closedNow);
  await expect(card).toContainText(t.clientsNow.closedToday);
  await expect.poll(() => !!calendar).toBe(true);
  await calendar!.fallback();
});

test('leaving setup stops further staff reads and a completed checklist is reused', async ({
  page,
}) => {
  await prepare(page);
  const staff = ['Anna', 'Ola'].map((name) => ({
    id: name,
    displayName: name,
    active: true,
    serviceIds: ['cut'],
  }));
  await page.route('**' + base + '/services', (route) =>
    route.fulfill({ json: [{ id: 'cut', active: true }] }),
  );
  await page.route('**' + base + '/staff', (route) => route.fulfill({ json: staff }));
  const calls: string[] = [];
  let first: Route | undefined;
  await page.route('**' + base + '/staff/*/working-hours', (route) => {
    calls.push(new URL(route.request().url()).pathname);
    if (!first) {
      first = route;
      return;
    }
    return route.fulfill({
      json: { weekly: [{ weekday: 2, intervals: [{ start: '09:00', end: '17:00' }] }] },
    });
  });
  await page.goto(app.url);
  await expect.poll(() => !!first).toBe(true);
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  const setup = page.getByRole('group', { name: t.setup.title });
  await tab(t.navigation.more).click();
  await expect(setup).toHaveCount(0);
  await tab(t.navigation.calendar).click();
  const summary = fill(t.setup.lead, { n: '1' });
  await expect(setup.getByRole('heading')).toHaveAccessibleDescription(summary);
  const finished = page.waitForEvent('requestfinished', (r) => r === first!.request());
  await first!.fulfill({ json: { weekly: [] } });
  await finished;
  await tab(t.navigation.more).click();
  await tab(t.navigation.calendar).click();
  await expect(setup.getByRole('heading')).toHaveAccessibleDescription(summary);
  expect(calls).toEqual(Array(2).fill(base + '/staff/Anna/working-hours'));
});

test('returning to Base reuses its status and typing a count renders one stocktake row', async ({
  page,
}) => {
  const reads = await prepare(page);
  await page.goto(app.url);
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  await tab(t.shop.open).click();
  for (let i = 0; i < 2; i++) {
    await tab(t.navigation.integrations).click();
    await expect(
      page.getByRole('heading', { name: t.shop.base.title }),
    ).toHaveAccessibleDescription(t.shop.base.off);
    await tab(t.navigation.products).click();
  }
  expect(reads(base + '/shop/integrations/base')).toBe(1);
  await page.getByRole('button', { name: `${t.navigation.inventory} ▸` }).click();
  await page.getByRole('button', { name: t.products.stocktake, exact: true }).click();
  const stock = page.getByTestId('stocktake');
  await expect(stock.getByTestId('stocktake-row')).toHaveCount(products.length);
  const initialReads = reads(base + '/products');
  await page.coverage.startJSCoverage();
  await stock
    .getByRole('textbox', {
      name: fill(t.products.stocktakeCount, { name: products[0]!.name }),
      exact: true,
    })
    .fill('9');
  await expect(stock.getByRole('button', { name: t.products.stocktakeSave })).toBeEnabled();
  expect(await renderCount(page, 'stocktake-row')).toBe(1);
  expect(reads(base + '/products')).toBe(initialReads);
});
