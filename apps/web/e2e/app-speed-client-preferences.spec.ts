import { expect, test } from '@playwright/test';
import { DICTIONARIES, LANGUAGE_NAMES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const { en, pl } = DICTIONARIES;
test.use({ viewport: { width: 320, height: 700 }, locale: 'pl-PL', isMobile: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await page.route('**/v1/client/appointments?scope=*', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/v1/client/waitlist', (r) => r.fulfill({ json: { items: [] } }));
});

test('a failed language save can be retried and a confirmed selection is reused', async ({
  page,
}) => {
  const saves: string[] = [];
  await page.route('**/v1/client/me', (route) => {
    if (route.request().method() === 'PATCH') {
      saves.push(route.request().postDataJSON().locale);
      if (saves.length === 1) return route.abort('connectionreset');
    }
    return route.fulfill({ json: { email: 'client@example.com', locale: saves.at(-1) ?? 'pl' } });
  });
  await page.goto(app.url);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await button(pl.visits.profile).click();
  await button(pl.language).click();
  await button(LANGUAGE_NAMES.en).click();
  await expect(page.getByRole('alert')).toHaveText(en.error.network);
  const retry = button(en.retry);
  const bounds = (await retry.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await retry.click();
  await expect(button(en.language)).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await button(en.language).click();
  const selected = page.getByRole('button', { name: LANGUAGE_NAMES.en, pressed: true });
  await selected.press('Enter');
  await expect(button(en.language)).toHaveAttribute('aria-expanded', 'false');
  await page.waitForLoadState('networkidle');
  expect(saves).toEqual(['en', 'en']);
});

test('leaving the booking during the first upload skips the remaining photo', async ({ page }) => {
  const id = 'e3aa0100-0000-4000-8000-000000000001';
  const service = {
    id,
    name: 'Cut',
    wishPhotos: true,
    durationMinutes: 30,
    priceGrosze: 7000,
    priceFromGrosze: 7000,
    priceToGrosze: 7000,
  };
  const staff = { id: 'ola', displayName: 'Ola', serviceIds: [id], languages: [], prices: [] };
  const start = new Date(Date.now() + 86_400_000).toISOString();
  const slot = { start, date: start.slice(0, 10), time: '10:00', staffIds: [staff.id] };
  const base = '**/v1/public/locations/studio';
  await page.route('**/v1/client/me', (r) =>
    r.fulfill({ json: { email: 'client@example.com', locale: 'pl' } }),
  );
  await page.route(base, (r) =>
    r.fulfill({
      json: {
        name: 'Studio',
        slug: 'studio',
        services: [service],
        staff: [staff],
        wishQuestions: { mood: true, drinks: [], note: true },
        currency: 'PLN',
        timezone: 'Europe/Warsaw',
      },
    }),
  );
  await page.route(base + '/availability?*', (r) => r.fulfill({ json: { slots: [slot] } }));
  await page.route(base + '/holds', (r) =>
    r.fulfill({
      json: {
        ...slot,
        holdId: 'held',
        holdToken: 'example',
        serviceName: service.name,
        staffName: staff.displayName,
        priceGrosze: 7000,
        currency: 'PLN',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    }),
  );

  let release!: () => void;
  const firstUpload = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploads = 0;
  await page.route('**/v1/public/holds/held/photos', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
    uploads++;
    await firstUpload;
    return route.fulfill({ json: { id: String(uploads), url: '/photo-' + uploads } });
  });
  await page.goto(app.url + '/b/studio?service=' + id);
  await page.evaluate(() => {
    const fetch = window.fetch;
    document.documentElement.dataset.blobReads = '0';
    window.fetch = function (input, init) {
      if (String(input).startsWith('blob:')) {
        const { dataset } = document.documentElement;
        dataset.blobReads = String(Number(dataset.blobReads) + 1);
      }
      return fetch.call(this, input, init);
    };
  });

  await page.getByRole('button', { name: slot.time, exact: true }).click();
  await page.getByRole('button', { name: pl.wishStep.add }).click();
  const choice = page.getByRole('button', { name: new RegExp(pl.wishStep.mood.quiet) });
  await choice.press('Enter');
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await choice.press('Space');
  await expect(choice).toHaveAttribute('aria-pressed', 'false');

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: pl.wishStep.photosAdd }).click();
  const png = await page.evaluate(
    () => document.createElement('canvas').toDataURL().split(',')[1]!,
  );
  await (
    await chooser
  ).setFiles(
    ['one.png', 'two.png'].map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    })),
  );
  try {
    await expect.poll(() => uploads).toBe(1);
    await page.getByRole('button', { name: pl.book.back, exact: true }).click();
    await expect(page.getByRole('button', { name: slot.time, exact: true })).toBeVisible();
  } finally {
    release();
  }
  await page.waitForLoadState('networkidle');
  expect(uploads).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-blob-reads', '0');
});
