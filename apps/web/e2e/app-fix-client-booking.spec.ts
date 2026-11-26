import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { DICTIONARIES, fill, type Dictionary } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 800 }, isMobile: true, locale: 'pl' });

const salon = { slug: 'studio-dw', name: 'Studio DW', addressLine: 'Bema 91', city: 'Warszawa' };
const locationUrl = '**/v1/public/locations/' + salon.slug;
const service = {
  id: 'cut',
  name: 'Strzyżenie',
  durationMinutes: 45,
  priceGrosze: 9000,
  priceFromGrosze: 9000,
  priceToGrosze: 9000,
};
const staff = {
  id: 'ola',
  displayName: 'Ola',
  serviceIds: [service.id],
  languages: [],
  specialties: [],
  rating: null,
  reviewCount: 0,
  prices: [],
};
const product = {
  id: 'catalog-serum',
  name: 'Botanical serum',
  fromPriceGrosze: 4200,
  offers: [
    { productId: 'offer-serum', available: true, priceGrosze: 4200, currency: 'PLN', salon },
  ],
};
const search = 'Botanical';

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

async function openStart(page: Page, t: Dictionary) {
  await page.route('**/v1/public/locations?*', (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 0,
        openNowCount: 0,
        page: 1,
        pageCount: 1,
        specialtyCounts: {},
        languageCounts: {},
      },
    }),
  );
  await page.route(locationUrl, (route) =>
    route.fulfill({
      json: {
        ...salon,
        currency: 'PLN',
        timezone: 'Europe/Warsaw',
        categories: [],
        languages: [],
        photos: [],
        todayHours: { date: new Date().toISOString().slice(0, 10), intervals: [] },
        openingHours: [],
        services: [service],
        staff: [staff],
      },
    }),
  );
  await page.goto(app.url);
  // React Native Web uses fixed pixel sizes. Enlarge text and line spacing across screens.
  const heading = page.getByRole('heading', { name: t.signIn.title, exact: true });
  const original = await heading.evaluate((element) => {
    const size = parseFloat(getComputedStyle(element).fontSize);
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const key of ['fontSize', 'lineHeight'] as const) {
          const value = rule.style[key];
          if (value.endsWith('px')) rule.style[key] = parseFloat(value) * 1.3 + 'px';
        }
      }
    }
    return size;
  });
  expect(await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(
    original * 1.3,
    1,
  );
}

async function bookFromSearch(page: Page, t: Dictionary) {
  await page.route('**/v1/public/shop/products?*', (route) => {
    const products =
      new URL(route.request().url()).searchParams.get('q') === search ? [product] : [];
    return route.fulfill({ json: { products, total: products.length, page: 1, pageSize: 24 } });
  });
  await openStart(page, t);
  await page.getByRole('button', { name: t.shop.entry, exact: true }).click();
  await page.getByLabel(t.shop.search, { exact: true }).fill(search);
  await page.getByRole('button', { name: /^Botanical serum,/ }).click();
  await page.getByRole('button', { name: t.shop.bookAndPickUp + ': ' + salon.name }).click();
  await expect(page.getByRole('heading', { name: t.book.pickService, exact: true })).toBeVisible();
}

async function expectMessageFits(status: Locator) {
  const fits = await status.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return Array.from(range.getClientRects()).every((line) => line.left >= -1 && line.right <= 321);
  });
  expect(fits).toBe(true);
}

test('back from a recent salon returns directly to the start screen and its search', async ({
  page,
}) => {
  const t = DICTIONARIES.pl;
  await page.addInitScript((recent) => {
    localStorage.setItem('beauty.catalog.recent', JSON.stringify([recent]));
  }, salon);
  await page.route(locationUrl + '/free-today', (r) => r.fulfill({ json: { staffIds: [] } }));
  await page.route(locationUrl + '/reviews*', (r) =>
    r.fulfill({ json: { enabled: false, stars: [], staff: [], items: [], nextBefore: null } }),
  );
  await openStart(page, t);
  const homeSearch = page.getByLabel(t.catalog.startSearch, { exact: true });
  await homeSearch.fill('Bema');
  const recent = page.getByRole('group', { name: t.catalog.recent, exact: true });
  await recent.getByRole('button', { name: salon.name }).click();
  await expect(page.getByRole('button', { name: t.salon.book, exact: true })).toBeVisible();
  await page.getByRole('button', { name: t.salon.back, exact: true }).click();
  await expect(homeSearch).toBeVisible();
  await expect(homeSearch).toHaveValue('Bema');
  await expect(recent.getByRole('button', { name: salon.name })).toBeVisible();
});

test('back from the first pickup booking step restores the product and the shop search', async ({
  page,
}) => {
  const t = DICTIONARIES.pl;
  await bookFromSearch(page, t);
  await page.getByRole('button', { name: t.book.back, exact: true }).click();
  await expect(page.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: t.shop.backToShop, exact: true }).click();
  await expect(page.getByLabel(t.shop.search, { exact: true })).toHaveValue(search);
  await expect(page.getByRole('button', { name: /^Botanical serum,/ })).toBeVisible();
});

// Keep the response pending while the user can see and interact with the current screen.
async function delayResponse(page: Page, url: string, respond: (route: Route) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  await page.route(url, async (route) => {
    requests.push(route.request().postDataJSON());
    await gate;
    await respond(route);
  });
  return { release, requests };
}

for (const [locale, reserved] of [
  ['pl', true],
  ['en', false],
  ['uk', true],
  ['ru', false],
] as const) {
  test.describe(locale, () => {
    test.use({ locale });
    test(
      'ordinary times show the pending hold and confirmation reports the pickup ' +
        (reserved ? 'success' : 'failure'),
      async ({ page }) => {
        const t = DICTIONARIES[locale];
        const b = t.book;
        const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
        const slots = ['10:00', '11:00'].map((time) => ({
          date,
          time,
          start: date + 'T' + time + ':00Z',
          staffIds: [staff.id],
        }));
        await page.route(locationUrl + '/availability?*', (route) =>
          route.fulfill({ json: { slots } }),
        );
        const hold = await delayResponse(page, locationUrl + '/holds', (route) =>
          route.fulfill({
            json: {
              holdId: 'hold-dw',
              holdToken: 'test',
              expiresAt: new Date(Date.now() + 600000).toISOString(),
              date,
              time: '10:00',
              serviceName: service.name,
              staffName: staff.displayName,
              currency: 'PLN',
              priceGrosze: 9000,
              listPriceGrosze: null,
            },
          }),
        );
        const heldUrl = '**/v1/public/holds/hold-dw';
        await page.route(heldUrl + '/code', (route) => route.fulfill({ status: 204 }));
        await page.route(heldUrl + '/confirm', (route) =>
          route.fulfill({
            json: {
              manageToken: 'visit-dw',
              appointment: { date, time: '10:00', service, staff },
            },
          }),
        );
        const pickup = await delayResponse(
          page,
          '**/v1/public/appointments/visit-dw/products',
          (route) => (reserved ? route.fulfill({ json: {} }) : route.abort('internetdisconnected')),
        );
        const button = (name: string | RegExp) => page.getByRole('button', { name, exact: true });
        const field = (name: string) => page.getByRole('textbox', { name, exact: true });
        const status = page.getByRole('status');
        try {
          await bookFromSearch(page, t);
          await button(/^Strzyżenie,/).click();
          await button('10:00').dblclick();
          await expect(button('10:00')).toBeDisabled();
          await expect(button('11:00')).toBeDisabled();
          await expect(status).toHaveText(fill(b.holdingTime, { time: '10:00' }));
          await expectMessageFits(status);
          hold.release();
          await field(b.name).fill('Alex Nowak');
          expect(hold.requests).toEqual([
            expect.objectContaining({ serviceId: service.id, staffId: staff.id }),
          ]);
          await field(b.phone).fill('600100200');
          await field(b.email).fill('guest@example.com');
          await page.getByRole('checkbox', { name: b.acceptTerms, exact: true }).click();
          await button(b.sendCode).click();
          await field(b.codeTitle).fill('246810');
          await button(b.confirm).click();
          const confirmedVisit = page.getByRole('heading', { name: b.doneTitle, exact: true });
          await expect(confirmedVisit).toBeVisible();
          await expect(status).toHaveText(t.visitProducts.reserving);
          await expect
            .poll(() => pickup.requests)
            .toEqual([{ productId: 'offer-serum', quantity: 1 }]);
          pickup.release();
          const products = t.visitProducts;
          await expect(status).toContainText(
            fill(reserved ? products.brought : products.reserveUnconfirmed, { n: '1' }),
          );
          if (!reserved) await expect(status).not.toContainText(fill(products.brought, { n: '1' }));
          await expectMessageFits(status);
          await expect(confirmedVisit).toBeVisible();
        } finally {
          hold.release();
          pickup.release();
        }
      },
    );
  });
}
