import { expect, test, type Route } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { auditLocales, enlargeText, expectFits } from './app-audit-client-fixture';
import { serveApp } from './mobile-app';

const salon = {
  name: 'Studio Sfera',
  slug: 'studio-sfera',
  city: 'Warszawa',
  addressLine: 'Bema 91',
  postalCode: '01-233',
  currency: 'PLN',
  timezone: 'Europe/Warsaw',
  languages: ['uk'],
  distanceKm: null,
  latitude: 52.231,
  longitude: 20.981,
  rating: null,
  priceFromGrosze: null,
  todayHours: [],
};
const neighbor = { ...salon, slug: 'fika', name: 'Fika', distanceKm: 2 };
const detail = {
  ...salon,
  todayHours: { date: '2026-11-26', intervals: [] },
  openingHours: [],
  categories: [],
  services: [],
  staff: [],
  photos: [],
};
const empty = {
  items: [],
  total: 0,
  page: 1,
  pageCount: 0,
  openNowCount: 0,
  languageCounts: {},
  specialtyCounts: {},
};
const reviews = {
  enabled: true,
  count: 0,
  average: null,
  stars: [0, 0, 0, 0, 0],
  staff: [],
  items: [],
  nextBefore: null,
};

for (const locale of auditLocales) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 844 }, isMobile: true });

    test('empty searches, offline map, salon details and voucher retry at 130%', async ({
      page,
    }) => {
      const t = DICTIONARIES[locale];
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const base = '**/v1/public/locations/' + salon.slug;
      await page.route('https://tile.openstreetmap.org/**', (route) =>
        route.abort('internetdisconnected'),
      );
      let searches = 0;
      let pendingSearch: Route | undefined;
      await page.route('**/v1/public/locations?**', (route) => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('nearSalon') === salon.slug)
          return route.fulfill({ json: { ...empty, pageCount: 1, total: 1, items: [neighbor] } });
        if (
          params.get('pageSize') === '1' ||
          params.has('nearSalon') ||
          params.has('language') ||
          params.has('openNow')
        )
          return route.fulfill({ json: empty });
        if (params.get('q') === salon.name)
          return route.fulfill({ json: { ...empty, items: [salon], total: 1, pageCount: 1 } });
        if (params.has('q')) return route.fulfill({ json: empty });
        searches++;
        if (searches === 1) return route.abort('internetdisconnected');
        if (searches === 2) pendingSearch = route;
        else return route.fulfill({ json: empty });
      });

      let salonReads = 0;
      await page.route(base, (route) => {
        salonReads++;
        if (salonReads === 1) return route.abort('internetdisconnected');
        return route.fulfill({ json: detail });
      });
      await page.route(base + '/free-today', (route) => route.fulfill({ json: { staffIds: [] } }));
      await page.route(base + '/reviews', (route) => route.fulfill({ json: reviews }));
      const neighborPath = '**/v1/public/locations/' + neighbor.slug;
      await page.route(neighborPath, (route) =>
        route.fulfill({ json: { ...detail, slug: neighbor.slug, name: neighbor.name } }),
      );
      await page.route(neighborPath + '/reviews', (route) => route.fulfill({ json: reviews }));
      await page.route(neighborPath + '/free-today', (route) =>
        route.fulfill({ json: { staffIds: [] } }),
      );
      let checks = 0;
      let pendingCheck: Route | undefined;
      await page.route(base + '/gift-vouchers/TEST', (route) => {
        checks++;
        if (checks === 1) {
          pendingCheck = route;
          return;
        }
        return route.fulfill({
          json: {
            status: 'used',
            amountGrosze: 5000,
            balanceGrosze: 0,
            currency: 'PLN',
            validUntil: null,
          },
        });
      });

      const app = await serveApp('mobile-client');
      try {
        await page.goto(app.url);
        const lead = page.getByText(t.catalog.startLead, { exact: true });
        await expect(lead).toBeVisible();
        await enlargeText(lead);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        const recentlyViewed = page.getByRole('group', { name: t.catalog.recent });
        await expect(recentlyViewed).toHaveCount(0);
        await button(t.catalog.searchGo).click();
        await expect(page.getByRole('alert')).toHaveText(t.error.network);
        await button(t.retry).dblclick();
        await expect.poll(() => Boolean(pendingSearch)).toBe(true);
        await expect(page.getByRole('progressbar')).toBeVisible();
        await pendingSearch!.fulfill({ json: empty });
        await expect(
          page.getByText(fill(t.catalog.found, { n: '0' }), { exact: true }),
        ).toBeVisible();
        expect(searches).toBe(2);
        await expect(page.getByRole('article')).toHaveCount(0);
        await button(t.catalog.filterLanguage).click();
        const ukrainian = button(t.spoken.uk + ' (0)');
        const filtered = page.waitForResponse(
          (response) => new URL(response.url()).searchParams.get('language') === 'uk',
        );
        await ukrainian.click();
        await filtered;
        await expect(ukrainian).toHaveAttribute('aria-pressed', 'true');
        await expectFits(page.getByText(t.catalog.empty, { exact: true }));
        await button(t.catalog.clearLanguages).click();
        await button(t.catalog.filterLanguage).click();
        const openNow = button(t.catalog.openNow + ' (0)');
        await openNow.click();
        await expectFits(page.getByText(t.catalog.openNowEmpty, { exact: true }));
        await openNow.click();
        const search = page.getByRole('searchbox', { name: t.catalog.search, exact: true });
        await search.fill('missing salon');
        await expect(page.getByText(t.catalog.noMatch, { exact: true })).toBeVisible();
        await search.fill(salon.name);
        const card = page.getByRole('article', { name: salon.name });
        await expectFits(card.getByRole('button', { name: t.catalog.open }));
        const map = page.getByRole('region', { name: t.catalog.mapTitle });
        await expect(map.getByRole('alert')).toHaveText(t.catalog.mapOffline);
        await map
          .getByRole('button', { name: fill(t.catalog.marker, { name: salon.name }) })
          .click();
        const pin = page.getByRole('region', { name: salon.name });
        await expectFits(pin.getByText(t.catalog.notFreeToday));
        await button(t.catalog.viewList).click();
        await expect(map).toHaveCount(0);
        await card.getByRole('button', { name: t.catalog.open }).dblclick();
        await expect(page.getByRole('alert')).toHaveText(t.error.network);
        expect(salonReads).toBe(1);
        await button(t.retry).click();
        await expectFits(page.getByText(t.salon.noServices, { exact: true }));
        await expect(page.getByRole('heading', { name: t.salon.team })).toHaveCount(0);
        const nearby = page.getByRole('link', { name: neighbor.name, exact: true });
        await expectFits(nearby);
        const reviewPanel = page.getByRole('region', { name: t.salonReviews.title });
        await expect(reviewPanel.getByRole('status')).toHaveText(t.salonReviews.title + ': 0');
        await expectFits(reviewPanel.getByRole('status'));
        await button(t.salon.about + ' ▸').click();
        await button(t.salon.qrShow).click();
        await expect(page.getByRole('img', { name: t.salon.qrAlt })).toBeVisible();

        await button(t.voucherCheck.open).click();
        const code = page.getByRole('textbox', { name: t.voucherCheck.code });
        const check = button(t.voucherCheck.check);
        await expect(check).toBeDisabled();
        await code.fill('TEST');
        await check.dblclick();
        await code.press('Enter');
        await expect(check).toBeDisabled();
        await expect.poll(() => Boolean(pendingCheck)).toBe(true);
        await pendingCheck!.abort('internetdisconnected');
        await expect(code).toHaveAccessibleDescription(t.error.network);
        await expectFits(page.getByRole('alert'));
        await expect(code).toHaveValue('TEST');
        expect(checks).toBe(1);
        await button(t.retry).click();
        await expect(
          page.getByRole('status').filter({ hasText: t.voucherCheck.statusUsed }),
        ).toContainText(t.voucherCheck.noEnd);
        expect(checks).toBe(2);
        const nearbyLoaded = page.waitForResponse(
          (response) => new URL(response.url()).searchParams.get('nearSalon') === neighbor.slug,
        );
        await nearby.click();
        await nearbyLoaded;
        await expectFits(page.getByRole('heading', { name: neighbor.name, exact: true }));
        await expect(page.getByRole('heading', { name: t.salon.nearbyTitle })).toHaveCount(0);
        await button(t.salon.back).click();
        await expect(search).toHaveValue(salon.name);
        await button(t.salon.back).click();
        await expect(recentlyViewed.getByRole('button', { name: salon.name })).toBeVisible();
        await expect(recentlyViewed.getByRole('button', { name: neighbor.name })).toBeVisible();
        await recentlyViewed.getByRole('button', { name: t.catalog.recentClear }).click();
        await expect(recentlyViewed).toHaveCount(0);
      } finally {
        app.server.close();
      }
    });
  });
}
