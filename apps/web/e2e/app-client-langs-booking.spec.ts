import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const names = {
  en: [
    'Long hair consultation with colouring and an evening hairstyle',
    'Alexandra Montgomery-Wellington',
  ],
  uk: [
    'Консультація з фарбування та вечірня зачіска для довгого волосся',
    'Олександра Коваленко-Вишневецька',
  ],
  ru: [
    'Консультация по окрашиванию и вечерняя укладка длинных волос',
    'Александра Коваленко-Вишневецкая',
  ],
} as const;

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

// React Native Web uses pixel sizes. Scale its text rules once so later steps inherit them too.
async function enlargeText(heading: Locator) {
  const before = await heading.evaluate((element) => {
    const initial = parseFloat(getComputedStyle(element).fontSize);
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const property of ['font-size', 'line-height']) {
          const value = rule.style.getPropertyValue(property);
          if (value.endsWith('px'))
            rule.style.setProperty(property, parseFloat(value) * 1.3 + 'px');
        }
      }
    }
    return initial;
  });
  await expect(heading).toHaveCSS('font-size', (before * 1.3).toFixed(1) + 'px');
}

async function expectTextFits(page: Page) {
  const clipped = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const errors = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement!;
      if (!element.checkVisibility()) continue;
      const bounds = element.getBoundingClientRect();
      // Spaces at wrap points can hang past the edge of a line.
      for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        if (
          [...range.getClientRects()].some(
            (line) =>
              line.left < Math.max(0, bounds.left) - 1 ||
              line.right > Math.min(innerWidth, bounds.right) + 1 ||
              line.top < bounds.top - 1 ||
              line.bottom > bounds.bottom + 1,
          )
        ) {
          errors.push(node.textContent);
          break;
        }
      }
    }
    return errors;
  });
  expect(clipped).toEqual([]);
}

async function expectFieldError(field: Locator, message: string, next: Locator) {
  const alert = field.locator('..').getByRole('alert');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(alert).toHaveText('! ' + message);
  const [input, error, following] = await Promise.all([
    field.boundingBox(),
    alert.boundingBox(),
    next.boundingBox(),
  ]);
  expect(error!.y).toBeGreaterThanOrEqual(input!.y + input!.height - 1);
  expect(error!.y + error!.height).toBeLessThanOrEqual(following!.y + 1);
}

async function mockBooking(page: Page, service: string, specialist: string) {
  const base = '**/v1/public/locations/studio-bf';
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const time = '10:00';
  const hold = '**/v1/public/holds/hold-bf';
  await page.route(base, (route) =>
    route.fulfill({
      json: {
        slug: 'studio-bf',
        name: 'Studio BF',
        addressLine: 'Bema 91',
        city: 'Warszawa',
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
            priceToGrosze: 9000,
          },
        ],
        staff: [specialist, 'Marek'].map((displayName, i) => ({
          id: String(i),
          displayName,
          serviceIds: ['cut'],
          prices: [{ serviceId: 'cut', priceGrosze: 9000 }],
          specialties: [],
          languages: [],
          rating: null,
          reviewCount: 0,
        })),
      },
    }),
  );
  await page.route(base, (route) => route.fulfill({ status: 503, json: {} }), { times: 1 });
  await page.route(base + '/availability?*', (route) =>
    route.fulfill({
      json: {
        slots: [{ date, time, start: date + 'T10:00:00Z', staffIds: ['0'], discountPercent: 20 }],
      },
    }),
  );
  await page.route(base + '/holds', (route) =>
    route.fulfill({
      json: {
        holdId: 'hold-bf',
        holdToken: 'test',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        date,
        time,
        serviceName: service,
        staffName: specialist,
        currency: 'PLN',
        listPriceGrosze: 9000,
        priceGrosze: 7200,
        happyHourPercent: 20,
      },
    }),
  );
  await page.route(hold + '/code', (route) => route.fulfill({ status: 204 }));
  await page.route(hold + '/confirm', (route) =>
    route.request().postDataJSON().code === '246810'
      ? route.fulfill({
          json: {
            manageToken: 'test',
            appointment: {
              date,
              time,
              service: { name: service },
              staff: { displayName: specialist },
            },
          },
        })
      : route.fulfill({ status: 400, json: { error: { code: 'INVALID_CODE' } } }),
  );
}

for (const locale of ['en', 'uk', 'ru'] as const) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 700 }, isMobile: true });
    test('guest corrects the phone and code and books a discounted visit at 130% text size', async ({
      page,
    }) => {
      const t = DICTIONARIES[locale];
      const b = t.book;
      const [service, specialist] = names[locale];
      await mockBooking(page, service, specialist);

      // An unavailable service link opens OpenBooking and falls back to service selection.
      await page.goto(
        app.url + '/' + locale + '/b/studio-bf?service=00000000-0000-4000-8000-000000000000',
      );
      const button = (name: string | RegExp) => page.getByRole('button', { name, exact: true });
      await expect(button(t.retry)).toBeVisible();
      await enlargeText(page.getByRole('heading', { name: b.title, exact: true }));
      await expectTextFits(page);
      await button(t.retry).click();

      await expect(page.getByRole('heading', { name: b.pickService, exact: true })).toBeVisible();
      const choice = button(new RegExp('^' + service + ',.*45.*' + t.units.min + '.*90'));
      await expect(choice).toBeVisible();
      await expectTextFits(page);
      await choice.click();
      await expect(page.getByRole('heading', { name: b.pickStaff, exact: true })).toBeVisible();
      const person = button(new RegExp('^' + specialist + ',.*10:00'));
      await expect(person).toBeVisible();
      await expectTextFits(page);
      await person.click();
      await expect(page.getByRole('heading', { name: b.pickTime, exact: true })).toBeVisible();
      const slot = button(
        new RegExp('^10:00 .*' + t.visit.price + ' .*90.*' + t.visit.discount + ' −20%$'),
      );
      await expect(slot.getByText(/−20%/)).toBeVisible();
      await expect(slot.getByText(/90/)).toHaveCSS('text-decoration-line', 'line-through');
      await expectTextFits(page);
      await slot.click();
      await expect(
        page.getByRole('group', {
          name: new RegExp(t.visit.discount + ' −20%.*' + t.visit.toPay + ' .*72'),
        }),
      ).toBeVisible();

      const field = (name: string) => page.getByRole('textbox', { name, exact: true });
      const phone = field(b.phone);
      const email = field(b.email);
      await field(b.name).fill('Alex Nowak');
      await phone.fill('12');
      await email.fill('guest@example.com');
      await page.getByRole('checkbox', { name: b.acceptTerms, exact: true }).click();
      await button(b.sendCode).click();
      await expectFieldError(phone, b.badPhone, page.getByText(b.email, { exact: true }));
      await expectTextFits(page);
      await phone.fill('600 100 200');
      await expect(phone.locator('..').getByRole('alert')).toHaveCount(0);
      await button(b.sendCode).click();

      const code = field(b.codeTitle);
      await code.fill('111111');
      await button(b.confirm).click();
      await expectFieldError(code, t.signIn.badCode, button(b.confirm));
      await expectTextFits(page);
      await code.fill('246810');
      await expect(code.locator('..').getByRole('alert')).toHaveCount(0);
      await button(b.confirm).click();
      await expect(page.getByRole('heading', { name: b.doneTitle, exact: true })).toBeVisible();
      await expect(page.getByText(service + ' · ' + specialist, { exact: true })).toBeVisible();
      await expectTextFits(page);
    });
  });
}
