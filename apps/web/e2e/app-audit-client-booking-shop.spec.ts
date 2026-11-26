import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';
import { auditLocales, enlargeText, expectFits } from './app-audit-client-fixture';

test.use({ viewport: { width: 320, height: 800 }, isMobile: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

const salon = { slug: 'studio-dq', name: 'Studio DQ', addressLine: 'Bema 91', city: 'Warszawa' };
const locationUrl = '**/v1/public/locations/' + salon.slug;
const shopUrl = '**/v1/public/shop/products?*';
const product = {
  id: 'serum',
  name: 'Serum',
  fromPriceGrosze: 4200,
  offers: [{ productId: 'serum', available: true, priceGrosze: 4200, currency: 'PLN', salon }],
};
const service = {
  id: '22400000-0000-4000-8000-000000000001',
  name: 'Laminacja',
  durationMinutes: 45,
  priceGrosze: 9000,
  priceFromGrosze: 9000,
  priceToGrosze: 9000,
  wishPhotos: true,
};
const staff = ['Kaja', 'Ola'].map((name) => ({
  id: name,
  displayName: name,
  prices: [],
  serviceIds: [service.id],
  languages: [],
  specialties: [],
  rating: null,
  reviewCount: 0,
}));
const location = {
  ...salon,
  currency: 'PLN',
  timezone: 'Europe/Warsaw',
  categories: [],
  services: [service],
  staff,
  wishQuestions: { mood: true, drinks: ['tea'], note: true },
};

// Keep the API pending until the two presses are delivered, even on a fast CI runner.
async function doubleSubmit(page: Page, button: Locator, endpoint: string, json: object) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  await page.route(endpoint, async (route) => {
    requests.push(route.request().postDataJSON());
    await gate;
    await route.fulfill({ json });
  });
  try {
    await button.dblclick();
    await expect.poll(() => requests.length).toBe(1);
  } finally {
    release();
  }
  return requests;
}

async function signedIn(page: Page, locale: string) {
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'test-client'));
  await page.route('**/v1/client/me', (r) =>
    r.fulfill({ json: { email: 'client@example.com', locale } }),
  );
  await page.route('**/v1/client/waitlist', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/v1/client/appointments?scope=*', (r) => r.fulfill({ json: { items: [] } }));
}

for (const locale of auditLocales) {
  test.describe(locale, () => {
    test.use({ locale });
    const t = DICTIONARIES[locale];
    const b = t.book;

    test('shop search recovers offline and one pickup follows one guest booking', async ({
      page,
    }) => {
      const button = (name: string | RegExp) => page.getByRole('button', { name, exact: true });
      let stocked = false;
      await page.route(shopUrl, (route) => {
        const query = new URL(route.request().url()).searchParams.get('q');
        if (query && !stocked) return route.abort('internetdisconnected');
        const products = stocked && query === product.name ? [product] : [];
        return route.fulfill({ json: { products, total: products.length, page: 1, pageSize: 24 } });
      });
      await page.route(locationUrl, (r) => r.fulfill({ json: location }));
      const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const slot = {
        time: '10:00',
        date,
        start: date + 'T09:00:00Z',
        staffIds: ['Kaja'],
        discountPercent: 20,
      };
      await page.route(locationUrl + '/availability?*', (r) =>
        r.fulfill({ json: { slots: [slot] } }),
      );
      const hold = {
        ...slot,
        holdId: 'audit-hold',
        holdToken: 'test-hold',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        serviceName: service.name,
        staffName: 'Kaja',
        priceGrosze: 7200,
        listPriceGrosze: 9000,
        happyHourPercent: 20,
        currency: 'PLN',
      };
      const heldUrl = '**/v1/public/holds/' + hold.holdId;
      let photosReads = 0;
      await page.route(heldUrl + '/photos', (r) =>
        ++photosReads === 1 ? r.abort('internetdisconnected') : r.fulfill({ json: { items: [] } }),
      );
      const pickups: unknown[] = [];
      await page.route('**/v1/public/appointments/test-visit/products', (r) => {
        pickups.push(r.request().postDataJSON());
        return r.fulfill({ json: {} });
      });

      await page.goto(app.url);
      await button(t.shop.entry).click();
      const heading = (name: string) => page.getByRole('heading', { name, exact: true });
      await enlargeText(heading(t.shop.title));
      await expect(page.getByRole('status')).toHaveText(t.shop.empty);
      await expectFits(page.getByRole('status'));
      const search = page.getByLabel(t.shop.search, { exact: true });
      await search.fill(product.name);
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await expect(search).toHaveValue(product.name);
      stocked = true;
      await button(t.retry).click();
      await button(/^Serum,/).click();
      await expectFits(heading(product.name));
      await button(t.shop.bookAndPickUp + ': ' + salon.name).click();
      await expectFits(heading(b.pickService));
      await button(/^Laminacja,/).click();
      await expectFits(heading(b.pickStaff));
      await button(/^Kaja(,|$)/).click();
      await expectFits(heading(b.pickTime));
      const discountedTime = button(/^10:00.*−20%$/);
      await expectFits(discountedTime);
      await expect(discountedTime.getByText(/90/)).toHaveCSS(
        'text-decoration-line',
        'line-through',
      );
      const holds = await doubleSubmit(page, discountedTime, locationUrl + '/holds', hold);
      await page.getByRole('textbox', { name: b.name, exact: true }).fill('Alex Nowak');
      await page.getByRole('textbox', { name: b.phone, exact: true }).fill('600100200');
      await page.getByRole('textbox', { name: b.email, exact: true }).fill('guest@example.com');
      await page.getByRole('checkbox', { name: b.acceptTerms, exact: true }).click();
      const codes = await doubleSubmit(page, button(b.sendCode), heldUrl + '/code', {});
      await expect(button(b.confirm)).toBeDisabled();
      await button(t.wishStep.add).click();
      const photos = page.getByRole('region', { name: t.wishStep.photosQ });
      await expect(photos.getByRole('alert')).toHaveText(t.error.network);
      await photos.getByRole('button', { name: t.retry }).click();
      await expect(photos.getByRole('button', { name: t.wishStep.photosAdd })).toBeEnabled();
      await expectFits(photos.getByRole('heading'));
      const note = page.getByRole('textbox', { name: t.wishStep.noteQ });
      await note.fill('Bez lakieru');
      await page.getByRole('textbox', { name: b.codeTitle }).fill('246810');
      const confirmations = await doubleSubmit(page, button(b.confirm), heldUrl + '/confirm', {
        manageToken: 'test-visit',
        appointment: { ...slot, service: { name: service.name }, staff: { displayName: 'Kaja' } },
      });
      await expectFits(heading(b.doneTitle));
      await expect(page.getByRole('status')).toContainText(
        fill(t.visitProducts.brought, { n: '1' }),
      );
      expect(holds).toEqual([expect.objectContaining({ serviceId: service.id, staffId: 'Kaja' })]);
      expect(codes).toEqual([expect.objectContaining({ email: 'guest@example.com', locale })]);
      expect(confirmations).toEqual([
        expect.objectContaining({
          code: '246810',
          wishes: { mood: null, drink: null, note: 'Bez lakieru' },
        }),
      ]);
      expect(pickups).toEqual([{ productId: product.id, quantity: 1 }]);
      expect(photosReads).toBe(2);
    });

    test('pickup waits for the existing visits, including after an offline failure', async ({
      page,
    }) => {
      await signedIn(page, locale);
      await page.route(shopUrl, (r) =>
        r.fulfill({ json: { products: [product], total: 1, page: 1 } }),
      );
      await page.goto(app.url);
      await page.getByRole('button', { name: t.shop.entry }).click();
      const row = page.getByRole('button', { name: /^Serum,/ });
      await expect(row).toBeVisible();
      const upcomingUrl = '**/v1/client/appointments?scope=upcoming';
      const upcoming = {
        id: 'existing-visit',
        salon,
        status: 'confirmed',
        timezone: location.timezone,
        start: new Date(Date.now() + 86400000).toISOString(),
      };
      await page.route(upcomingUrl, (r) => r.fulfill({ json: { items: [upcoming] } }));
      let pending!: () => void;
      const gate = new Promise<void>((r) => {
        pending = r;
      });
      let attempts = 0;
      await page.route(
        upcomingUrl,
        async (r) => {
          attempts++;
          await gate;
          await r.abort('internetdisconnected');
        },
        { times: 1 },
      );
      const bookNew = page.getByRole('button', { name: t.shop.bookAndPickUp + ': ' + salon.name });
      try {
        await row.click();
        await enlargeText(page.getByRole('heading', { name: product.name, exact: true }));
        await expect.poll(() => attempts).toBe(1);
        await expect(bookNew).toHaveCount(0);
      } finally {
        pending();
      }
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await expect(bookNew).toHaveCount(0);
      await page.getByRole('button', { name: t.retry }).click();
      const reserve = page
        .getByRole('button')
        .filter({ hasText: t.shop.reserve.split('{when}')[0]!.trim() });
      await expectFits(reserve);
      await expect(reserve).toBeEnabled();
      await expect(bookNew).toHaveCount(0);
    });

    test('waitlist retains the name offline and submits one request on retry', async ({ page }) => {
      await signedIn(page, locale);
      await page.route(locationUrl, (r) => r.fulfill({ json: { ...location, staff: [staff[0]] } }));
      await page.route(locationUrl + '/availability?*', (r) => r.fulfill({ json: { slots: [] } }));
      await page.goto(app.url + '/b/' + salon.slug + '?service=' + service.id);
      await enlargeText(page.getByRole('heading', { name: b.pickTime, exact: true }));
      await page.getByRole('button', { name: t.waitlist.open }).click();
      const day = page
        .getByRole('button', { name: new RegExp('^' + t.waitlist.wait + ':') })
        .first();
      await day.click();
      const name = page.getByRole('textbox', { name: b.name, exact: true });
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      await expectFits(page.getByRole('alert').filter({ hasText: t.waitlist.nameNeeded }));
      await name.fill('Alex Nowak');
      const waitUrl = '**/v1/client/waitlist/locations/' + salon.slug;
      await page.route(waitUrl, (r) => r.abort('internetdisconnected'), { times: 1 });
      await day.click();
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await expect(name).toHaveValue('Alex Nowak');
      const requests = await doubleSubmit(
        page,
        page.getByRole('button', { name: t.retry }),
        waitUrl,
        { alreadyWaiting: false },
      );
      await expect(day).toHaveAttribute('aria-pressed', 'true');
      await expectFits(page.getByRole('status'));
      expect(requests).toEqual([
        expect.objectContaining({ serviceId: service.id, name: 'Alex Nowak', locale }),
      ]);
    });

    test('empty services and empty availability explain the next step', async ({ page }) => {
      let acceptingBookings = false;
      await page.route(locationUrl, (r) =>
        r.fulfill({
          json: {
            ...location,
            services: acceptingBookings ? [service] : [],
            staff: acceptingBookings ? [staff[0]] : [],
          },
        }),
      );
      await page.route(locationUrl + '/availability?*', (r) => r.fulfill({ json: { slots: [] } }));
      const link = app.url + '/b/' + salon.slug + '?service=' + service.id;
      await page.goto(link);
      await enlargeText(page.getByRole('heading', { name: b.pickService, exact: true }));
      await expectFits(page.getByText(b.salonClosed, { exact: true }));
      acceptingBookings = true;
      await page.reload();
      await enlargeText(page.getByRole('heading', { name: b.pickTime, exact: true }));
      await expectFits(page.getByText(b.noSlotsAtAll, { exact: true }));
      await page.getByRole('button', { name: t.waitlist.open }).click();
      await expectFits(page.getByText(t.waitlist.signInFirst, { exact: true }));
    });
  });
}
