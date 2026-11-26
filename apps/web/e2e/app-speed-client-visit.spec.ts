import { expect, test, type Page, type Route } from '@playwright/test';
import { bookingUrl } from '../../mobile-client/src/api';
import { encodeQr } from '../../mobile-client/src/qr';
import { fill, DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

const detail = '**/v1/client/appointments/visit';

async function mockCompletedVisit(page: Page) {
  const salon = { slug: 'studio', name: 'Studio', addressLine: 'Prosta 1', city: 'Warszawa' };
  const visit = {
    id: 'visit',
    salon,
    status: 'completed',
    date: '2026-10-02',
    time: '10:00',
    start: '2026-10-02T08:00:00Z',
    end: '2026-10-02T08:30:00Z',
    timezone: 'Europe/Warsaw',
    currency: 'PLN',
    service: { id: 'cut', name: 'Classic', durationMinutes: 30, priceGrosze: 8000 },
    staff: { id: 'aleks', displayName: 'Aleks' },
    coupons: [],
    discountGrosze: 0,
    canChange: false,
    canChangeWishes: false,
  };
  const replies: Record<string, unknown> = {
    '**/v1/client/me': { email: 'client@example.test', locale: 'pl' },
    '**/v1/client/me/summary': { completed: 0, salons: 0, firstVisitAt: null, spent: [] },
    '**/v1/client/waitlist': { items: [] },
    '**/v1/client/appointments?scope=upcoming': { items: [] },
    '**/v1/client/appointments?scope=past': { items: [visit] },
    [detail]: visit,
    [detail + '/photos']: { items: [] },
  };
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  for (const [url, json] of Object.entries(replies)) {
    await page.route(url, (route) => route.fulfill({ json }));
  }
}

test('returning to a slow visit shares reads and the review rating is one keyboard stop', async ({
  page,
}) => {
  const app = await serveApp('mobile-client');
  await mockCompletedVisit(page);
  const reads = { reviews: 0, products: 0, used: 0 };
  const product = {
    id: 'serum',
    name: 'Serum',
    priceGrosze: 1200,
    photoId: null,
    brand: null,
    available: true,
  };
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.route(detail + '/review', async (route) => {
      reads.reviews++;
      await wait;
      await route.fulfill({ json: { canReview: true, review: null } });
    });
    await page.route(detail + '/products', (route) => {
      reads.products++;
      return route.fulfill({
        json: { reservations: [], available: [], canChange: false, currency: 'PLN' },
      });
    });
    await page.route(detail + '/products/used', (route) => {
      reads.used++;
      return route.fulfill({
        json: {
          products: [product],
          currency: 'PLN',
          nextVisit: { date: '2026-12-01', time: '10:00' },
        },
      });
    });
    await page.goto(app.url);
    const past = page.getByRole('tab', { name: t.visits.past });
    const open = page.getByRole('button', { name: '10:00 Classic, Studio' });
    const save = page.getByRole('button', {
      name: t.visitProducts.saveForNext + ': Serum',
      exact: true,
    });
    await past.click();
    await open.click();
    await expect(save).toBeVisible();
    await expect.poll(() => reads.reviews).toBe(1);
    await page.getByRole('button', { name: t.visit.back }).click();
    await past.click();
    await open.click();
    await expect(save).toBeVisible();
    release();
    const rating = page.getByRole('radiogroup', { name: t.review.rating });
    const star = (n: number) =>
      rating.getByRole('radio', { name: fill(t.review.outOf, { n: String(n) }) });
    await star(1).focus();
    await page.keyboard.press('Space');
    await expect(star(1)).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(star(5)).toBeFocused();
    await expect(star(5)).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(star(1)).toBeFocused();
    await expect(star(1)).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('textbox', { name: t.review.text })).toBeFocused();
    for (const control of [star(1), star(5), save]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    }
    expect(reads).toEqual({ reviews: 1, products: 1, used: 1 });
  } finally {
    release();
    app.server.close();
  }
});

test('both product lists offer a retry after a stalled read and ignore its late answer', async ({
  page,
}) => {
  const app = await serveApp('mobile-client');
  const held: Route[] = [];
  try {
    await page.clock.install();
    await mockCompletedVisit(page);
    await page.route(detail + '/review', (route) =>
      route.fulfill({ json: { canReview: false, review: null } }),
    );
    const counts = new Map<string, number>();
    const lists = [
      {
        suffix: '/products',
        title: t.visitProducts.title,
        result: { currency: 'PLN', reservations: [], canChange: false, available: [] },
      },
      {
        suffix: '/products/used',
        title: t.visitProducts.usedTitle,
        result: { currency: 'PLN', products: [] },
      },
    ];
    for (const { suffix, result } of lists) {
      await page.route(detail + suffix, async (route) => {
        const reads = (counts.get(suffix) ?? 0) + 1;
        counts.set(suffix, reads);
        if (reads === 1) held.push(route);
        else await route.fulfill({ json: result });
      });
    }
    await page.goto(app.url);
    await page.getByRole('tab', { name: t.visits.past }).click();
    await page.getByRole('button', { name: '10:00 Classic, Studio' }).click();
    await expect.poll(() => held.length).toBe(2);
    await page.clock.fastForward(30_001);
    for (const { suffix, title } of lists) {
      const card = page.getByRole('region', { name: title, exact: true });
      await expect(card.getByRole('alert')).toHaveText(t.error.network);
      await card.getByRole('button', { name: t.retry }).click();
      await expect.poll(() => counts.get(suffix)).toBe(2);
      await expect(card).toHaveCount(0);
    }
    for (const route of held) {
      const settled = page.waitForResponse((res) => res.request() === route.request());
      await route.fulfill({ status: 503, json: {} });
      await (await settled).finished();
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    app.server.close();
  }
});

test('the salon QR retains every module and four-module quiet zone in one path', async ({
  page,
}) => {
  const app = await serveApp('mobile-client');
  const salon = {
    slug: 'studio',
    name: 'Studio',
    timezone: 'Europe/Warsaw',
    currency: 'PLN',
    languages: [],
    addressLine: 'Prosta 1',
    city: 'Warszawa',
    postalCode: '00-001',
    phone: null,
  };
  const detail = '**/v1/public/locations/' + salon.slug;
  try {
    const replies = {
      '**/v1/public/locations?**': {
        items: [
          { ...salon, todayHours: [], rating: null, priceFromGrosze: null, distanceKm: null },
        ],
        total: 1,
        page: 1,
        pageCount: 1,
        specialtyCounts: {},
        languageCounts: {},
        openNowCount: 0,
      },
      [detail]: {
        ...salon,
        todayHours: { date: '2026-11-26', intervals: [] },
        openingHours: [],
        services: [],
        categories: [],
        photos: [],
        staff: [],
      },
      [detail + '/free-today']: { staffIds: [] },
      [detail + '/reviews']: { enabled: false, items: [] },
    };
    for (const [url, json] of Object.entries(replies)) {
      await page.route(url, (route) => route.fulfill({ json }));
    }
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await page.goto(app.url);
    await button(t.catalog.searchGo).click();
    await page
      .getByRole('article', { name: salon.name })
      .getByRole('button', { name: t.catalog.open })
      .click();
    await button(t.salon.about + ' ▸').click();
    await button(t.salon.qrShow).click();
    const qr = page.getByRole('img', { name: t.salon.qrAlt, exact: true });
    const path = qr.locator('path');
    await expect(path).toHaveCount(1);
    const actual = await path.evaluate((element: SVGPathElement) => {
      const side = element.ownerSVGElement!.viewBox.baseVal.width;
      return Array.from({ length: side }, (_, y) =>
        Array.from({ length: side }, (_, x) =>
          element.isPointInFill(new DOMPoint(x + 0.5, y + 0.5)) ? '1' : '0',
        ).join(''),
      );
    });
    const symbol = encodeQr(
      bookingUrl(process.env.EXPO_PUBLIC_WEB_URL ?? 'http://localhost:3000', 'pl', salon.slug),
    );
    const side = symbol.size + 8;
    const expected = Array.from({ length: side }, (_, y) =>
      Array.from({ length: side }, (_, x) =>
        x >= 4 && y >= 4 && x < side - 4 && y < side - 4 && symbol.isDark(x - 4, y - 4) ? '1' : '0',
      ).join(''),
    );
    expect(actual).toEqual(expected);
  } finally {
    app.server.close();
  }
});
