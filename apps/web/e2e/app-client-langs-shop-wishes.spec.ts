import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../../mobile-client/src/locales/en';
import { ru } from '../../mobile-client/src/locales/ru';
import { uk } from '../../mobile-client/src/locales/uk';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

const salon = {
  slug: 'studio',
  name: 'Studio Magnolia',
  city: 'Warszawa',
  addressLine: 'Prosta 5',
};
const stockItem = {
  id: 'serum',
  brand: 'Botanical Collection',
  photoId: 'product-photo',
  priceGrosze: 123456789,
  available: true,
};
const locales = [
  {
    code: 'en',
    tag: 'en-GB',
    t: en,
    name: 'ConcentratedRestorativeConditioningTreatment Extra Long',
  },
  {
    code: 'uk',
    tag: 'uk-UA',
    t: uk,
    name: 'ІнтенсивноВідновлювальнийКондиціонер для довгого волосся',
  },
  {
    code: 'ru',
    tag: 'ru-RU',
    t: ru,
    name: 'ИнтенсивноВосстанавливающийКондиционер для длинных волос',
  },
] as const;

// Expo web declares text sizes in pixels. Enlarge its text and leading once, including
// screens opened later, while keeping spacing, images and the layout viewport unchanged.
async function enlargeText(page: Page) {
  const changed = await page.evaluate(() => {
    let fonts = 0;
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const key of ['fontSize', 'lineHeight'] as const) {
          const value = rule.style[key];
          if (value.endsWith('px')) {
            rule.style[key] = parseFloat(value) * 1.3 + 'px';
            if (key === 'fontSize') fonts++;
          }
        }
      }
    }
    return fonts;
  });
  expect(changed).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(320);
}

// Check the painted words, including wrapped parts of an unbroken product name.
// Comparing their rectangles also catches text overlapping the price or another action.
async function expectReadable(section: Locator) {
  await expect(section).toBeVisible();
  const problems = await section.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const painted: { node: Node; rect: DOMRect }[] = [];
    const problems = new Set<string>();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement!;
      const box = parent.getBoundingClientRect();
      for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        for (const rect of range.getClientRects()) {
          if (
            rect.left < Math.max(box.left, 0) - 1 ||
            rect.right > Math.min(box.right, document.documentElement.clientWidth) + 1 ||
            rect.top < box.top - 1 ||
            rect.bottom > box.bottom + 1 ||
            painted.some(
              (other) =>
                other.node !== node &&
                Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) > 1 &&
                Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) > 1,
            )
          )
            problems.add(word[0]);
          painted.push({ node, rect });
        }
      }
    }
    return [...problems];
  });
  expect(problems).toEqual([]);
}

async function signIn(page: Page, locale: string) {
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await page.route('**/v1/client/me', (r) =>
    r.fulfill({ json: { email: 'client@example.com', locale } }),
  );
  await page.route('**/v1/client/me/summary', (r) =>
    r.fulfill({ json: { completed: 1, salons: 1, firstVisitAt: '2020-01-02', spent: [] } }),
  );
  await page.route('**/v1/client/waitlist', (r) => r.fulfill({ json: { items: [] } }));
}

async function mockVisits(
  page: Page,
  locale: string,
  product: typeof stockItem & { name: string },
) {
  const start = new Date(Date.now() + 7 * 86400000).toISOString();
  const upcoming = {
    id: 'upcoming',
    start,
    date: start.slice(0, 10),
    time: '10:00',
    status: 'confirmed',
    timezone: 'Europe/Warsaw',
    currency: 'PLN',
    salon,
    service: { id: 'cut', name: 'Haircut', durationMinutes: 30, priceGrosze: 7000 },
    staff: { id: 'ola', displayName: 'Ola' },
    canChangeWishes: true,
    wishes: { mood: null, drink: null, note: null },
    wishQuestions: { mood: true, drinks: ['tea'], note: true },
    coupons: [],
    discountGrosze: 0,
  };
  const past = {
    ...upcoming,
    id: 'past',
    status: 'completed',
    date: '2020-01-02',
    start: '2020-01-02T09:00:00Z',
    canChangeWishes: false,
  };
  await signIn(page, locale);
  for (const visit of [upcoming, past]) {
    await page.route('**/v1/client/appointments?scope=' + visit.id, (r) =>
      r.fulfill({ json: { items: [visit] } }),
    );
    await page.route('**/v1/client/appointments/' + visit.id, (r) => r.fulfill({ json: visit }));
  }
  await page.route('**/v1/client/appointments/*/review', (r) =>
    r.fulfill({ json: { canReview: false, review: null } }),
  );
  await page.route('**/v1/client/appointments/*/photos', (r) =>
    r.fulfill({
      json: {
        items: r.request().url().includes('/upcoming/')
          ? [{ id: 'style', url: '/v1/public/photos/style' }]
          : [],
      },
    }),
  );
  await page.route('**/v1/client/appointments/upcoming/photos/style', (r) =>
    r.fulfill({ status: 204 }),
  );
  await page.route('**/v1/public/photos/*', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    }),
  );
  await page.route('**/v1/client/appointments/upcoming/wishes', (r) =>
    r.fulfill({
      status: 400,
      json: { error: { code: 'VALIDATION_ERROR', details: [{ path: 'note' }] } },
    }),
  );
  await page.route('**/v1/client/appointments/upcoming/products', (r) =>
    r.fulfill({
      json: {
        currency: 'PLN',
        canChange: true,
        available: [product],
        totalGrosze: product.priceGrosze,
        reservations: [
          { ...product, quantity: 1, status: 'reserved', totalGrosze: product.priceGrosze },
        ],
      },
    }),
  );
  await page.route('**/v1/client/appointments/past/products', (r) =>
    r.fulfill({
      json: { currency: 'PLN', canChange: false, available: [], reservations: [], totalGrosze: 0 },
    }),
  );
  await page.route('**/v1/client/appointments/past/products/used', (r) =>
    r.fulfill({
      json: {
        currency: 'PLN',
        products: [product],
        nextVisit: { date: upcoming.date, time: '10:00' },
      },
    }),
  );
}

for (const { code, tag, t, name } of locales) {
  const product = { ...stockItem, name };
  test.describe(tag, () => {
    test.use({ locale: tag });
    const price = new Intl.NumberFormat(tag, { style: 'currency', currency: 'PLN' }).format(
      product.priceGrosze / 100,
    );

    test('shop names, prices and empty states fit at 130%', async ({ page }) => {
      const listed = {
        ...product,
        fromPriceGrosze: product.priceGrosze,
        offers: [{ ...product, productId: product.id, currency: 'PLN', salon }],
      };
      let stock = false;
      await page.route('**/v1/public/shop/products?*', (r) => {
        const products = stock && !new URL(r.request().url()).searchParams.has('q') ? [listed] : [];
        return r.fulfill({ json: { products, total: products.length, page: 1, pageSize: 24 } });
      });
      await page.goto(app.url);
      const entry = page.getByRole('button', { name: t.shop.entry });
      await entry.click();
      const status = page.getByRole('status');
      await expect(status).toHaveText(t.shop.empty);
      await enlargeText(page);
      await expectReadable(status);
      await page.getByRole('button', { name: t.salon.back }).click();
      stock = true;
      await entry.click();
      const from = t.shop.from.replace('{price}', price);
      const item = page.getByRole('button', { name: product.name + ', ' + from, exact: true });
      await expect(item.getByText(from, { exact: true })).toBeVisible();
      await expectReadable(item);
      await item.click();
      const title = page.getByRole('heading', { name: product.name });
      await expect(title).toHaveCSS('font-size', '33.8px');
      await expectReadable(title);
      await expectReadable(page.getByText(price, { exact: true }).locator('..'));
      await expectReadable(
        page.getByRole('button', { name: t.shop.bookAndPickUp + ': ' + salon.name }),
      );
      await page.getByRole('button', { name: t.shop.backToShop }).click();
      await page.getByLabel(t.shop.search).fill('missing');
      await expect(status).toHaveText(t.shop.noMatch);
      await expectReadable(status);
      await page.getByRole('button', { name: t.catalog.clearLanguages }).click();
      await expect(item).toBeVisible();
    });

    test('booking photo instructions and upload error fit at 130%', async ({ page }) => {
      await signIn(page, code);
      const id = 'e3aa0100-0000-4000-8000-000000000001';
      const service = {
        id,
        name: 'Haircut',
        durationMinutes: 30,
        priceGrosze: 7000,
        priceFromGrosze: 7000,
        priceToGrosze: 7000,
        wishPhotos: true,
      };
      const start = new Date(Date.now() + 86400000).toISOString();
      const slot = { time: '10:00', date: start.slice(0, 10), start, staffIds: ['ola'] };
      await page.route('**/v1/public/locations/studio', (r) =>
        r.fulfill({
          json: {
            ...salon,
            timezone: 'Europe/Warsaw',
            currency: 'PLN',
            services: [service],
            staff: [{ id: 'ola', displayName: 'Ola', serviceIds: [id], languages: [], prices: [] }],
            wishQuestions: { mood: false, drinks: [], note: false },
          },
        }),
      );
      await page.route('**/v1/public/locations/studio/availability?*', (r) =>
        r.fulfill({ json: { slots: [slot] } }),
      );
      await page.route('**/v1/public/locations/studio/holds', (r) =>
        r.fulfill({
          json: {
            ...slot,
            holdId: 'held',
            holdToken: 'example',
            serviceName: service.name,
            staffName: 'Ola',
            priceGrosze: 7000,
            listPriceGrosze: null,
            currency: 'PLN',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        }),
      );
      await page.route('**/v1/public/holds/held/photos', (r) =>
        r.request().method() === 'GET'
          ? r.fulfill({ json: { items: [] } })
          : r.fulfill({ status: 413, json: { error: { code: 'PHOTO_TOO_LARGE' } } }),
      );
      await page.goto(app.url + '/b/studio?service=' + id);
      await page.getByRole('button', { name: slot.time, exact: true }).click();
      await page.getByRole('button', { name: t.wishStep.add }).click();
      const photos = page.getByRole('region', { name: t.wishStep.photosQ });
      const add = photos.getByRole('button', { name: t.wishStep.photosAdd });
      await expect(add).toBeEnabled();
      await enlargeText(page);
      const chooser = page.waitForEvent('filechooser');
      await add.click();
      const png = await page.evaluate(
        () => document.createElement('canvas').toDataURL('image/png').split(',')[1]!,
      );
      await (
        await chooser
      ).setFiles({ name: 'wish.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(photos.getByRole('alert')).toContainText(t.wishStep.photosTooLarge);
      await expectReadable(photos);
    });

    test('visit products, wishes, field errors and photos fit at 130%', async ({ page }) => {
      await mockVisits(page, code, product);
      await page.goto(app.url);
      const visit = page.getByRole('button', { name: '10:00 Haircut, Studio Magnolia' });
      await visit.click();
      const w = t.wishStep;
      const wishes = page.getByRole('region', { name: w.title });
      await expect(wishes).toBeVisible();
      await enlargeText(page);
      const mood = wishes
        .getByRole('group', { name: w.moodQ })
        .getByRole('button', { name: w.mood.relax });
      await mood.click();
      await expect(mood).toHaveAttribute('aria-pressed', 'true');
      const tea = wishes
        .getByRole('group', { name: w.drinkQ })
        .getByRole('button', { name: w.drink.tea });
      await tea.click();
      const note = wishes.getByRole('textbox', { name: w.noteQ });
      await note.fill('Sensitive scalp');
      await page.getByRole('button', { name: w.save }).click();
      await expect(note).toHaveAttribute('aria-invalid', 'true');
      await expect(note.locator('..').getByRole('alert')).toContainText(w.badNote);
      await expectReadable(wishes);
      const photos = page.getByRole('region', { name: w.photosQ });
      const alt = w.photoAlt.replace('{n}', '1');
      await expect(photos.getByRole('img', { name: alt })).toBeVisible();
      await expectReadable(photos);
      await photos.getByRole('button', { name: w.photosRemove + ': ' + alt }).click();
      await expect(photos).toHaveCount(0);
      const s = t.visitProducts;
      const pickup = page.getByRole('region', { name: s.title });
      await pickup.getByRole('button', { name: s.add }).click();
      await expect(
        pickup.getByRole('button', { name: s.giveBack + ': ' + product.name }),
      ).toBeVisible();
      await expect(
        pickup.getByRole('button', { name: s.reserve + ': ' + product.name }),
      ).toBeVisible();
      await expect(pickup.getByText(product.name, { exact: true })).toBeVisible();
      await expect(pickup.getByText(price, { exact: true })).toHaveCount(2);
      await expectReadable(pickup);
      await page.getByRole('button', { name: t.visit.back, exact: true }).click();
      await page.getByRole('tab', { name: t.visits.past }).click();
      await visit.click();
      const used = page.getByRole('region', { name: s.usedTitle });
      await expect(
        used.getByRole('button', { name: s.saveForNext + ': ' + product.name }),
      ).toBeVisible();
      await expect(used.getByRole('img', { name: product.name })).toBeVisible();
      await expect(used.getByText(price, { exact: true })).toBeVisible();
      await expectReadable(used);
    });
  });
}
