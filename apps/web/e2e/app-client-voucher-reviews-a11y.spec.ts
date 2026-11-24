import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 700 }, isMobile: true });

const salon = {
  slug: 'studio-bp',
  name: 'Studio Magnolia',
  addressLine: 'Jasna 12',
  postalCode: '00-001',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  languages: [],
};
const hours = [{ start: '00:00', end: '24:00' }];
const review = {
  id: 'review-four',
  rating: 4,
  text: 'Bardzo miła obsługa, chętnie wrócę na kolejne strzyżenie.',
  staffName: 'Aleksandra Nowak',
  serviceName: 'Strzyżenie',
  createdAt: '2026-11-23T12:00:00Z',
};

async function mockSalon(page: Page) {
  const base = '**/v1/public/locations';
  await page.route(base + '?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { ...salon, todayHours: hours, rating: null, distanceKm: null, priceFromGrosze: null },
        ],
        page: 1,
        pageCount: 1,
        total: 1,
        openNowCount: 1,
        specialtyCounts: {},
        languageCounts: {},
      },
    }),
  );
  const detail = base + '/' + salon.slug;
  await page.route(detail, (route) =>
    route.fulfill({
      json: {
        ...salon,
        todayHours: { date: '2026-11-24', intervals: hours },
        openingHours: [],
        categories: [],
        services: [],
        staff: [],
        photos: [],
      },
    }),
  );
  await page.route(detail + '/free-today', (route) => route.fulfill({ json: { staffIds: [] } }));
  await page.route(detail + '/reviews*', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        count: 2,
        average: 4.5,
        stars: [0, 0, 0, 1, 1],
        staff: [],
        items: [review],
        nextBefore: null,
      },
    }),
  );
  await page.route(detail + '/gift-vouchers/ZZZZ-ZZZZ', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    }),
  );
}

// Expo web uses pixel sizes. Scale the font rules once so newly opened sections inherit the test size.
async function enlargeText(page: Page, sample: Locator) {
  const fontSize = () => sample.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await fontSize();
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const key of ['fontSize', 'lineHeight'] as const) {
          const value = rule.style[key];
          if (value.endsWith('px')) rule.style[key] = parseFloat(value) * 1.3 + 'px';
        }
      }
    }
  });
  expect(await fontSize()).toBeCloseTo(original * 1.3, 1);
}

async function expectFits(element: Locator) {
  await expect(element).toBeVisible();
  const layout = await element.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      inViewport: box.left >= 0 && box.right <= 321,
      contentFits: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout).toEqual({ inViewport: true, contentFits: true, pageWidth: 320 });
}

async function expectTarget(control: Locator) {
  await expectFits(control);
  const box = (await control.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

for (const locale of ['pl', 'en', 'uk', 'ru'] as const) {
  test.describe(locale, () => {
    test.use({ locale });
    test('salon status, voucher error, ratings and QR at 320 px with 130% text', async ({
      page,
    }) => {
      const t = DICTIONARIES[locale];
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      await mockSalon(page);
      await page.goto(app.url);
      await button(t.catalog.searchGo).click();
      const card = page.getByRole('article', { name: salon.name });
      const status = card.getByRole('status', { name: t.salon.openUntilMidnight, exact: true });
      await enlargeText(page, status);
      await expectFits(status);
      const filter = button(t.catalog.openNow + ' (1)');
      await expectTarget(filter);
      await expect(filter).toHaveAttribute('aria-pressed', 'false');
      await filter.click();
      await expect(filter).toHaveAttribute('aria-pressed', 'true');
      await card.getByRole('button', { name: t.catalog.open }).click();

      const openVoucher = button(t.voucherCheck.open);
      await expectTarget(openVoucher);
      await openVoucher.click();
      const code = page.getByRole('textbox', { name: t.voucherCheck.code, exact: true });
      await expectFits(page.getByText(t.voucherCheck.code, { exact: true }));
      await expectTarget(code);
      const check = button(t.voucherCheck.check);
      await expect(check).toBeDisabled();
      await code.fill('ZZZZ-ZZZZ');
      await expectTarget(check);
      await check.click();
      const error = page.getByRole('alert').filter({ hasText: t.voucherCheck.notFound });
      await expectFits(error);
      await expect(code).toHaveAttribute('aria-invalid', 'true');
      await expect(code).toHaveAccessibleDescription('! ' + t.voucherCheck.notFound);
      await code.fill('');
      await expect(error).toHaveCount(0);
      await expect(code).toHaveAttribute('aria-invalid', 'false');
      await expect(code).toHaveAccessibleDescription('');

      const reviews = page.getByRole('region', { name: t.salonReviews.title });
      const average = fill(t.review.outOf, { n: new Intl.NumberFormat(locale).format(4.5) });
      await expectFits(
        reviews.getByRole('img', {
          name: average + ', ' + t.salonReviews.title + ': 2',
          exact: true,
        }),
      );
      const rating = fill(t.review.outOf, { n: '4' });
      await expectFits(reviews.getByRole('img', { name: rating, exact: true }));
      await expectFits(reviews.getByText(review.text));
      const fourStars = reviews.getByRole('radio', { name: '★ 4 (1)', exact: true });
      await expectTarget(fourStars);
      await expect(fourStars).toHaveAccessibleDescription(
        rating + ', ' + t.salonReviews.title + ': 1',
      );
      await fourStars.click();
      await expect(fourStars).toBeChecked();

      await button(t.salon.about + ' ▸').click();
      const showQr = button(t.salon.qrShow);
      await expectTarget(showQr);
      await showQr.click();
      const qr = page.getByRole('img', { name: t.salon.qrAlt, exact: true });
      await expectFits(qr);
      const box = (await qr.boundingBox())!;
      expect(box.width).toBeCloseTo(box.height, 0);
      await expectFits(page.getByText(t.salon.qrHint));
      const hideQr = button(t.salon.qrHide);
      await expectTarget(hideQr);
      await hideQr.click();
      await expect(qr).toHaveCount(0);
    });
  });
}
