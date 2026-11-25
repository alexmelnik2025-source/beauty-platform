import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

declare global {
  interface Window {
    reviewWork: { summary: number; rows: number[] };
  }
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const location = {
  id: 'salon',
  name: 'Salon CO',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};
const base = '**/v1/organizations/co/locations/salon';
let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'co-session'),
  );
  await page.route('**/v1/**', (route) => route.abort());
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({ json: { accessToken: 'co-access', refreshToken: 'co-session' } }),
  );
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'owner' },
        organizations: [{ id: 'co', name: location.name, role: 'owner' }],
      },
    }),
  );
  await page.route('**/v1/organizations/co/locations', (route) =>
    route.fulfill({ json: [location] }),
  );
  await page.goto(app.url);
  await page.getByRole('tab', { name: pl.navigation.more }).click();
});

const guard = {
  enabled: true,
  version: 1,
  maxChanges: null,
  windowHours: 720,
  lateCancelMinutes: null,
  maxNoShows: 2,
  action: 'approval',
};
const marked = (name: string) => ({
  currency: 'PLN',
  items: [
    {
      customerId: 'one',
      name,
      rule: 'salon',
      reasons: ['no_shows'],
      noShows: 2,
      noShowAmountGrosze: 0,
    },
  ],
});

test('opening rules and returning reuse the guarded clients', async ({ page }) => {
  const reads = { settings: 0, clients: 0 };
  await page.route(base + '/cancellation-guard', (route) => {
    reads.settings++;
    return route.fulfill({ json: guard });
  });
  await page.route(base + '/cancellation-guard/clients', (route) => {
    reads.clients++;
    return route.fulfill({ json: marked('Anna CO') });
  });
  await button(page, pl.guard.open).click();
  await expect(page.getByText('Anna CO', { exact: true })).toBeVisible();
  await button(page, pl.guard.rulesChange).click();
  await button(page, pl.guard.cancel).click();
  await button(page, pl.guard.back).click();
  await button(page, pl.guard.open).click();
  await expect(page.getByText('Anna CO', { exact: true })).toBeVisible();
  expect(reads).toEqual({ settings: 1, clients: 1 });
});

test('a guarded client list abandoned on exit cannot replace the next visit', async ({ page }) => {
  await page.route(base + '/cancellation-guard', (route) => route.fulfill({ json: guard }));
  let reads = 0;
  let finishFirst!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  await page.route(base + '/cancellation-guard/clients', async (route) => {
    const first = ++reads === 1;
    if (first) await delayed;
    await route.fulfill({ json: marked(first ? 'Stare dane' : 'Nowe dane') });
  });
  try {
    await button(page, pl.guard.open).click();
    await expect.poll(() => reads).toBe(1);
    const cancelled = page.waitForEvent('requestfailed', (req) =>
      req.url().endsWith('/cancellation-guard/clients'),
    );
    await button(page, pl.guard.back).click();
    await button(page, pl.guard.open).click();
    await expect(page.getByText('Nowe dane', { exact: true })).toBeVisible();
    finishFirst();
    await cancelled;
    await expect(page.getByText('Nowe dane', { exact: true })).toBeVisible();
    await expect(page.getByText('Stare dane', { exact: true })).toHaveCount(0);
    expect(reads).toBe(2);
  } finally {
    finishFirst();
  }
});

test('typing and publishing touch only the chosen review, and returning reuses the list', async ({
  page,
}) => {
  // Keep every fixture in FlatList's initial batch so lazy mounts cannot enter the render counts.
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: 'review-' + i,
    text: 'Opinia ' + i,
    rating: 4,
    customerName: 'Klient ' + i,
    serviceName: 'Broda',
    staffName: 'Anna',
    visitStartAt: `2026-11-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    reply: i === 1 ? 'Poprzednia odpowiedź' : null,
  }));
  const reads: string[] = [];
  const writes: string[] = [];
  await page.route(base + '/review-settings', (route) =>
    route.fulfill({ json: { enabled: true, requestHours: 3, version: 1 } }),
  );
  await page.route(/\/locations\/salon\/reviews(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).search;
    reads.push(query);
    return route.fulfill({
      json: {
        enabled: true,
        count: items.length,
        average: 4,
        stars: [0, 0, 0, items.length, 0],
        unanswered: items.filter((item) => !item.reply).length,
        staff: [],
        services: [],
        items: query ? items.filter((item) => !item.reply) : items,
        nextBefore: null,
      },
    });
  });
  await page.route(base + '/reviews/review-0/reply', (route) => {
    const { text } = route.request().postDataJSON();
    writes.push(text);
    items[0]!.reply = text;
    return route.fulfill({ json: items[0] });
  });
  await button(page, pl.reviews.open).click();
  const row = page.getByRole('group', { name: /^Klient 0 ·/ });
  const unanswered = page.getByRole('button', { name: /^Bez odpowiedzi/ });
  await expect(row).toBeVisible();
  const answeredRow = page.getByRole('group', { name: /^Klient 1 ·/ });
  await expect(answeredRow).toBeVisible();
  await unanswered.click();
  await expect(answeredRow).toHaveCount(0);
  await unanswered.click();
  await expect(answeredRow).toBeVisible();
  await row.getByRole('button', { name: pl.reviews.reply, exact: true }).click();
  const field = row.getByRole('textbox', { name: pl.reviews.replyLabel });
  await expect(page.getByRole('group', { name: /^Klient \d+ ·/ })).toHaveCount(items.length);
  // Count the summary and each review's date formatting on the actual React render path.
  await page.evaluate(() => {
    const counts = { summary: 0, rows: [] as number[] };
    window.reviewWork = counts;
    const numbers = Intl.NumberFormat;
    Intl.NumberFormat = new Proxy(numbers, {
      construct(target, args) {
        if (args[1]?.minimumFractionDigits === 1) counts.summary++;
        return Reflect.construct(target, args);
      },
    });
    const prototype = Intl.DateTimeFormat.prototype;
    const format = Object.getOwnPropertyDescriptor(prototype, 'format')!;
    Object.defineProperty(prototype, 'format', {
      ...format,
      get() {
        const original = format.get!.call(this);
        return (date: Date) => {
          if (
            date instanceof Date &&
            date.getUTCFullYear() === 2026 &&
            date.getUTCMonth() === 10 &&
            date.getUTCHours() === 10
          )
            counts.rows.push(date.getUTCDate());
          return original(date);
        };
      },
    });
  });
  const work = () => page.evaluate(() => window.reviewWork);
  const draft = 'Dzięki';
  await field.pressSequentially(draft);
  await expect(field).toHaveValue(draft);
  const typing = await work();
  await row.getByRole('button', { name: pl.reviews.replySave }).click();
  await expect(row.getByText(draft, { exact: true })).toBeVisible();
  const saved = await work();
  await expect(unanswered).toHaveText(/6/);
  await button(page, pl.reviews.back).click();
  await button(page, pl.reviews.open).click();
  await expect(row.getByText(draft, { exact: true })).toBeVisible();
  await unanswered.click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText('Opinia 2', { exact: true })).toBeVisible();
  expect(reads).toEqual(['', '?unanswered=true']);
  expect(writes).toEqual([draft]);
  expect(typing).toEqual({ summary: 0, rows: [] });
  expect([...new Set(saved.rows)]).toEqual([1]);
});
