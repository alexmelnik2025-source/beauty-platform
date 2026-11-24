import { expect, test, type Page } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const service = 'Strzyżenie długich włosów z konsultacją i modelowaniem';
const specialist = 'Aleksandra Konstantynopolitańczykowianeczka';
const salon = {
  slug: 'studio-ap',
  name: 'Studio AP',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  categories: [],
  services: [
    {
      id: 'cut',
      name: service,
      categoryId: null,
      durationMinutes: 45,
      priceGrosze: 9000,
      priceFromGrosze: 9000,
      priceToGrosze: 11000,
    },
  ],
  staff: [specialist, 'Marek'].map((displayName, i) => ({
    id: String(i),
    displayName,
    rating: null,
    reviewCount: 0,
    serviceIds: ['cut'],
    specialties: [],
    languages: [],
    prices: [{ serviceId: 'cut', priceGrosze: i === 0 ? 9000 : 11000 }],
  })),
};

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => {
  app?.server.close();
});

// Expo web emits pixel values. Scale text and its line spacing without changing the 320px layout.
async function enlargeText(page: Page) {
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const property of ['font-size', 'line-height']) {
          const value = rule.style.getPropertyValue(property);
          if (value.endsWith('px'))
            rule.style.setProperty(property, `${parseFloat(value) * 1.3}px`);
        }
      }
    }
  });
}

async function checkLayout(page: Page) {
  const problems = await page.evaluate(() => {
    const errors: string[] = [];
    const width = document.documentElement.clientWidth;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement!;
      if (!node.textContent?.trim() || !parent.checkVisibility()) continue;
      const range = document.createRange();
      const bounds = parent.getBoundingClientRect();
      // Wrapped trailing spaces can hang outside the line. Measure the visible words.
      for (const word of node.textContent.matchAll(/\S+/g)) {
        range.setStart(node, word.index!);
        range.setEnd(node, word.index! + word[0].length);
        const line = range.getBoundingClientRect();
        if (
          line.left < Math.max(0, bounds.left) - 1 ||
          line.right > Math.min(width, bounds.right) + 1 ||
          line.top < bounds.top - 1 ||
          line.bottom > bounds.bottom + 1
        ) {
          errors.push(node.textContent);
          break;
        }
      }
    }
    for (const control of document.querySelectorAll(
      'button, [role="button"], [role="checkbox"], input',
    )) {
      if (!control.checkVisibility()) continue;
      const box = control.getBoundingClientRect();
      if (box.width < 44 || box.height < 44 || box.left < -1 || box.right > width + 1)
        errors.push(control.getAttribute('aria-label') ?? control.tagName);
    }
    return errors;
  });
  expect(problems).toEqual([]);
}

for (const locale of ['pl', 'en', 'uk', 'ru'] as const) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 700 }, isMobile: true });
    test('booking choices, discount and touch targets at 130% text size', async ({ page }) => {
      const t = DICTIONARIES[locale];
      const base = '**/v1/public/locations/studio-ap';
      await page.route(base, (route) => route.fulfill({ json: salon }));
      await page.route(base, (route) => route.fulfill({ status: 503, json: {} }), { times: 1 });
      const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      await page.route(base + '/availability?*', (route) =>
        route.fulfill({
          json: {
            slots: ['10:00', '11:00'].map((time, index) => ({
              date,
              time,
              start: `${date}T${time}:00Z`,
              staffIds: ['0'],
              discountPercent: index ? null : 20,
            })),
          },
        }),
      );
      await page.route(base + '/holds', (route) =>
        route.fulfill({
          json: {
            holdId: 'hold-ap',
            holdToken: 'test',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            date,
            time: '10:00',
            serviceName: service,
            staffName: specialist,
            currency: 'PLN',
            listPriceGrosze: 9000,
            priceGrosze: 7200,
            happyHourPercent: 20,
          },
        }),
      );

      // A stale service link opens the booking loader, then lets the client choose another service.
      await page.goto(
        `${app.url}/${locale}/b/studio-ap?service=00000000-0000-4000-8000-000000000000`,
      );
      const retry = page.getByRole('button', { name: t.retry });
      await expect(retry).toBeVisible();
      const title = page.getByRole('heading', { name: t.book.title, exact: true });
      const initialSize = await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      await enlargeText(page);
      await expect(title).toHaveCSS('font-size', `${(initialSize * 1.3).toFixed(1)}px`);
      await checkLayout(page);
      await retry.click();

      const choice = page.getByRole('button', { name: new RegExp('^' + service + ',.*45.*90') });
      await expect(choice).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: new RegExp('^.*' + specialist + '.*90.*' + service + '$'),
        }),
      ).toBeVisible();
      await checkLayout(page);
      await choice.click();
      const person = page.getByRole('button', {
        name: new RegExp('^' + specialist + ',.*10:00.*90'),
      });
      await expect(person).toBeVisible();
      await checkLayout(page);
      await person.click();

      const slot = page.getByRole('button', {
        name: new RegExp('^10:00 .*' + t.visit.price + ' .*90.*' + t.visit.discount + ' −20%$'),
      });
      await expect(slot).toBeVisible();
      await expect(slot.getByText(/90/)).toHaveCSS('text-decoration-line', 'line-through');
      await expect(page.getByRole('button', { name: '11:00', exact: true })).toBeVisible();
      await checkLayout(page);
      await slot.click();
      await expect(
        page.getByRole('group', {
          name: new RegExp(
            t.visit.price + ' .*90.*' + t.visit.discount + ' −20%.*' + t.visit.toPay + ' .*72',
          ),
        }),
      ).toBeVisible();
      await checkLayout(page);
    });
  });
}
