import { expect, test, type Locator, type Page } from '@playwright/test';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

const shopUrl = '**/v1/public/shop/products?*';
const shopEntry = /Sklep — kosmetyki z salonów/;
const product = {
  id: 'mask',
  name: 'Maska IntensywnieRegenerującaDoWłosówWysokoporowatych',
  brand: 'Pracownia Kosmetyczna',
  photoId: 'mask-photo',
  priceGrosze: 4900,
  available: true,
};
const salon = {
  name: 'Pracownia Pielęgnacji Włosów',
  slug: 'pracownia',
  city: 'Warszawa',
  addressLine: 'ul. Prosta 5',
};
const list = {
  products: [
    {
      ...product,
      fromPriceGrosze: product.priceGrosze,
      offers: [{ ...product, productId: product.id, currency: 'PLN', salon }],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 24,
};

async function expectTarget(button: Locator) {
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

// Expo web uses pixel sizes. Scale the text and its line spacing without widening the viewport.
async function expectLargeTextFits(section: Locator) {
  await expect(section).toBeVisible();
  const clipped = await section.evaluate((root) => {
    const labels = [root, ...root.querySelectorAll('*')].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        [...el.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        ),
    );
    const sizes = labels.map((el) => {
      const style = getComputedStyle(el);
      return { font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
    });
    labels.forEach((el, i) => {
      const { font, line } = sizes[i]!;
      el.style.fontSize = font * 1.3 + 'px';
      if (Number.isFinite(line)) el.style.lineHeight = line * 1.3 + 'px';
    });
    return labels
      .filter((el) => {
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        // A trailing space may hang outside a wrapped line. Measure the visible words.
        return [...el.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .some((node) =>
            [...(node.textContent ?? '').matchAll(/\S+/g)].some((word) => {
              range.setStart(node, word.index);
              range.setEnd(node, word.index + word[0].length);
              return [...range.getClientRects()].some(
                (line) =>
                  line.left < Math.max(0, box.left) - 1 ||
                  line.right > Math.min(innerWidth, box.right) + 1 ||
                  line.top < box.top - 1 ||
                  line.bottom > box.bottom + 1,
              );
            }),
          );
      })
      .map((el) => el.textContent);
  });
  expect(clipped).toEqual([]);
}

test('loading and empty shop states offer one way back or one way to clear the filters', async ({
  page,
}) => {
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  let catalogEmpty = true;
  await page.route(shopUrl, async (route) => {
    await loading;
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      json:
        catalogEmpty || params.has('category') || params.has('q')
          ? { products: [], total: 0, page: 1, pageSize: 24 }
          : list,
    });
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: shopEntry }).click();
  try {
    await expect(page.getByRole('progressbar', { name: 'Sklep' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByRole('status')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole('status')).toHaveText('Salony nie dodały jeszcze produktów.');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  const back = page.getByRole('button', { name: '‹ Wróć' });
  await expectTarget(back);
  await back.click();
  catalogEmpty = false;
  await page.getByRole('button', { name: shopEntry }).click();
  const item = page.getByRole('button', { name: new RegExp(product.name) });
  await expect(item).toBeVisible();
  const category = page.getByRole('button', { name: 'Broda', exact: true });
  await category.click();
  const search = page.getByLabel('Szukaj produktu lub marki');
  const searched = page.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === 'brak');
  await search.fill('brak');
  await searched;
  await expect(page.getByRole('status')).toHaveText('Nic nie znaleziono. Zmień wyszukiwanie.');
  const clear = page.getByRole('button', { name: 'Wyczyść' });
  await expectTarget(clear);
  await clear.click();
  await expect(search).toHaveValue('');
  await expect(category).toHaveAttribute('aria-pressed', 'false');
  await expect(item).toBeVisible();
});

// Open the normal signed-in screens with deterministic visits and photos, independent of salon stock.
async function visits(page: Page) {
  const start = new Date(Date.now() + 7 * 86400000).toISOString();
  const upcoming = {
    id: 'upcoming',
    status: 'confirmed',
    start,
    date: start.slice(0, 10),
    time: '10:00',
    timezone: 'Europe/Warsaw',
    currency: 'PLN',
    salon,
    service: { id: 'cut', name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 7000 },
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
    canChangeWishes: false,
    date: '2020-01-02',
    start: '2020-01-02T09:00:00Z',
  };
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await page.route('**/v1/client/me', (r) =>
    r.fulfill({ json: { email: 'client@example.com', locale: 'pl' } }),
  );
  await page.route('**/v1/client/waitlist', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/v1/client/me/summary', (r) => r.fulfill({ json: { completed: 0 } }));
  for (const visit of [upcoming, past]) {
    await page.route('**/v1/client/appointments?scope=' + visit.id, (r) =>
      r.fulfill({ json: { items: [visit] } }),
    );
    await page.route('**/v1/client/appointments/' + visit.id, (r) => r.fulfill({ json: visit }));
  }
  await page.route('**/v1/client/appointments/*/review', (r) =>
    r.fulfill({ json: { canReview: false, review: null } }),
  );
  await page.route('**/v1/public/photos/*', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    }),
  );
}

test('photos, wishes and reservation actions stay readable and tappable at 130% on a 320 px screen', async ({
  page,
}) => {
  await visits(page);
  await page.route(shopUrl, (r) => r.fulfill({ json: list }));
  let reserved = false;
  await page.route('**/v1/client/appointments/upcoming/products', (r) => {
    if (r.request().method() === 'POST') {
      expect(r.request().postDataJSON()).toMatchObject({ productId: product.id });
      reserved = true;
    }
    return r.fulfill({
      json: {
        currency: 'PLN',
        canChange: true,
        available: [product],
        totalGrosze: reserved ? 4900 : 0,
        reservations: reserved
          ? [{ ...product, status: 'reserved', quantity: 1, totalGrosze: 4900 }]
          : [],
      },
    });
  });
  await page.route('**/v1/client/appointments/upcoming/photos', (r) =>
    r.fulfill({
      json: {
        items: [
          { id: 'first', url: '/v1/public/photos/first' },
          { id: 'second', url: '/v1/public/photos/second' },
        ],
      },
    }),
  );
  await page.route('**/v1/client/appointments/upcoming/photos/second', (r) => {
    expect(r.request().method()).toBe('DELETE');
    return r.fulfill({ status: 204 });
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: shopEntry }).click();
  const item = page.getByRole('button', { name: new RegExp(product.name) });
  await expectLargeTextFits(item);
  await expectTarget(item);
  await item.click();
  await expect(page.getByRole('img', { name: product.name })).toBeVisible();
  await expectLargeTextFits(page.getByRole('heading', { name: product.name }));
  const reserve = page.getByRole('button', {
    name: new RegExp('^Odbiorę przy wizycie .*, ' + product.name + ': ' + salon.name + '$'),
  });
  await expectLargeTextFits(reserve);
  await expectTarget(reserve);
  await reserve.click();
  await expect(page.getByRole('alert')).toContainText('Odłożone na wizytę');
  await page.getByRole('button', { name: '‹ Sklep' }).click();
  await page.getByRole('button', { name: '‹ Wróć' }).click();
  await page.getByRole('button', { name: /Strzyżenie, Pracownia/ }).click();
  const wishes = page.getByRole('region', { name: 'Twoje życzenia' });
  await expectLargeTextFits(wishes);
  const mood = wishes
    .getByRole('group', { name: 'Jak chcesz spędzić wizytę?' })
    .getByRole('button', { name: /Wolę ciszę/ });
  await expectTarget(mood);
  await mood.click();
  await expect(mood).toHaveAttribute('aria-pressed', 'true');
  const second = page.getByRole('img', { name: 'Twoje zdjęcie 2' });
  await expect(second).toBeVisible();
  const remove = page.getByRole('button', { name: 'Usuń: Twoje zdjęcie 2' });
  await expectLargeTextFits(remove);
  await expectTarget(remove);
  await remove.click();
  await expect(second).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Twoje zdjęcie 1' })).toHaveAttribute(
    'src',
    /\/first$/,
  );
  const pickup = page.getByRole('region', { name: 'Produkty do odbioru' });
  await expect(pickup.getByRole('img', { name: product.name })).toBeVisible();
  await pickup.getByRole('button', { name: '+ Dodaj produkt do tej wizyty' }).click();
  await expectLargeTextFits(pickup);
  await expectTarget(pickup.getByRole('button', { name: 'Zrezygnuj: ' + product.name }));
  await expectTarget(pickup.getByRole('button', { name: 'Odbiorę przy wizycie: ' + product.name }));
});

test('a used product has a named photo and a readable next-visit reservation button', async ({
  page,
}) => {
  await visits(page);
  await page.route('**/v1/client/appointments/past/photos', (r) =>
    r.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/client/appointments/past/products', (r) =>
    r.fulfill({ json: { reservations: [], available: [], canChange: false } }),
  );
  await page.route('**/v1/client/appointments/past/products/used', (r) =>
    r.fulfill({
      json: {
        currency: 'PLN',
        products: [product],
        nextVisit: { date: '2030-01-02', time: '10:00' },
      },
    }),
  );
  await page.goto(app.url);
  await page.getByRole('tab', { name: 'Historia' }).click();
  await page.getByRole('button', { name: /Strzyżenie, Pracownia/ }).click();
  const used = page.getByRole('region', { name: 'Na wizycie użyto' });
  await expect(used.getByRole('img', { name: product.name })).toBeVisible();
  await expectLargeTextFits(used);
  await expectTarget(
    used.getByRole('button', { name: 'Odłóż na następną wizytę: ' + product.name }),
  );
});
