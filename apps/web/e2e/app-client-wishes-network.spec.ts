import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-client/src/locales/pl';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

const w = pl.wishStep;
const serviceId = 'e3aa0100-0000-4000-8000-000000000001';
const service = {
  id: serviceId,
  name: 'Strzyżenie',
  wishPhotos: true,
  durationMinutes: 30,
  priceGrosze: 7000,
  priceFromGrosze: 7000,
  priceToGrosze: 7000,
};
const salon = { slug: 'studio', name: 'Studio', city: 'Warszawa', addressLine: 'Prosta 5' };
const wishQuestions = { mood: true, drinks: ['tea'], note: true };
const staff = { id: 'ola', displayName: 'Ola', serviceIds: [serviceId], languages: [], prices: [] };
const location = '**/v1/public/locations/studio';
const photosUrl = '**/v1/public/holds/held/photos';
const visitUrl = '**/v1/client/appointments/upcoming';
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>';
const photo = (id: string) => ({ id, url: '/v1/public/photos/' + id });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function slot() {
  const start = new Date(Date.now() + 86400000).toISOString();
  return { start, date: start.slice(0, 10), time: '10:00', staffIds: [staff.id] };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await page.route('**/v1/public/locations?*', (r) =>
    r.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 50 } }),
  );
  await page.route('**/v1/client/me', (r) =>
    r.fulfill({ json: { email: 'client@example.com', locale: 'pl' } }),
  );
  await page.route('**/v1/client/me/summary', (r) =>
    r.fulfill({ json: { completed: 0, salons: 0, spent: [] } }),
  );
  await page.route('**/v1/client/waitlist', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/v1/client/appointments?scope=*', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/v1/public/photos/*', (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: image }),
  );
});

async function chooseWishes(page: Page) {
  const mood = page.getByRole('button', { name: /Wolę ciszę/ });
  const drink = page.getByRole('button', { name: /Herbata/ });
  const note = page.getByRole('textbox', { name: w.noteQ });
  await mood.click();
  await drink.click();
  await note.fill('Wrażliwa skóra');
  return async () => {
    await expect(mood).toHaveAttribute('aria-pressed', 'true');
    await expect(drink).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toHaveValue('Wrażliwa skóra');
  };
}

test('booking keeps the failed upload and wishes, and retries only the missing photo', async ({
  page,
}) => {
  const held = slot();
  await page.route(location, (r) =>
    r.fulfill({
      json: {
        ...salon,
        services: [service],
        staff: [staff],
        wishQuestions,
        currency: 'PLN',
        timezone: 'Europe/Warsaw',
      },
    }),
  );
  await page.route(location + '/availability?*', (r) => r.fulfill({ json: { slots: [held] } }));
  await page.route(location + '/holds', (r) =>
    r.fulfill({
      json: {
        ...held,
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
  let posts = 0;
  const items = [photo('original')];
  await page.route(photosUrl, async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { items } });
    posts++;
    if (posts === 2) return r.abort('connectionreset');
    const saved = photo('upload-' + posts);
    items.push(saved);
    await r.fulfill({ json: saved });
  });
  await page.goto(app.url + '/b/studio?service=' + serviceId);
  await page.getByRole('button', { name: held.time, exact: true }).click();
  await page.getByRole('button', { name: w.add }).click();
  const checkWishes = await chooseWishes(page);
  const photos = page.getByRole('region', { name: w.photosQ });
  const chooser = page.waitForEvent('filechooser');
  await photos.getByRole('button', { name: w.photosAdd }).click();
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
  await expect(photos.getByRole('alert')).toHaveText(pl.error.network);
  await expect(photos.getByRole('img', { name: 'Twoje zdjęcie 3' })).toBeVisible();
  await checkWishes();
  await photos.getByRole('button', { name: pl.retry }).click();
  await expect(photos.getByRole('button', { name: /^Usuń:/ })).toHaveCount(3);
  await expect(photos.getByRole('alert')).toHaveCount(0);
  expect(posts).toBe(3);

  // Two presses in one browser task, before the disabled state can repaint.
  const remove = photos.getByRole('button', { name: 'Usuń: Twoje zdjęcie 2' });
  let deletes = 0;
  const release = gate();
  await page.route(photosUrl + '/upload-1', async (r) => {
    deletes++;
    if (deletes === 1) {
      await release.promise;
      return r.abort('connectionreset');
    }
    await r.fulfill({ status: 204 });
  });
  try {
    await remove.evaluate((el) => {
      (el as HTMLElement).click();
      (el as HTMLElement).click();
    });
    await expect(remove).toBeDisabled();
    await expect.poll(() => deletes).toBe(1);
  } finally {
    release.resolve();
  }
  await expect(photos.getByRole('alert')).toHaveText(pl.error.network);
  const paths = () =>
    photos
      .locator('img')
      .evaluateAll((imgs) => imgs.map((img) => new URL((img as HTMLImageElement).src).pathname));
  expect(await paths()).toEqual(items.map((p) => p.url));
  await photos.getByRole('button', { name: pl.retry }).click();
  await expect(photos.getByRole('button', { name: /^Usuń:/ })).toHaveCount(2);
  expect(await paths()).toEqual([items[0]!.url, items[2]!.url]);
  expect(deletes).toBe(2);
  await checkWishes();
});

test('a visit recovers from a stalled list, broken thumbnail and lost delete response', async ({
  page,
}) => {
  const visit = {
    ...slot(),
    id: 'upcoming',
    status: 'confirmed',
    currency: 'PLN',
    timezone: 'Europe/Warsaw',
    salon,
    service,
    staff,
    canChangeWishes: true,
    wishes: { mood: null, drink: null, note: null },
    wishQuestions,
    coupons: [],
    discountGrosze: 0,
  };
  await page.route('**/v1/client/appointments?scope=upcoming', (r) =>
    r.fulfill({ json: { items: [visit] } }),
  );
  await page.route(visitUrl, (r) => r.fulfill({ json: visit }));
  await page.route(visitUrl + '/products', (r) =>
    r.fulfill({
      json: { currency: 'PLN', canChange: false, available: [], reservations: [], totalGrosze: 0 },
    }),
  );
  await page.route(visitUrl + '/review', (r) =>
    r.fulfill({ json: { canReview: false, review: null } }),
  );
  let reads = 0,
    deletes = 0,
    saves = 0;
  let items = [photo('style')];
  const delayed = gate();
  await page.route(visitUrl + '/photos', async (r) => {
    if (++reads === 1) {
      await delayed.promise;
      return r.fulfill({ json: { items: [] } });
    }
    await r.fulfill({ json: { items } });
  });
  await page.route('**/v1/public/photos/style', (r) => r.abort('connectionreset'));
  await page.route(visitUrl + '/photos/style', (r) => {
    deletes++;
    items = [];
    return r.abort('connectionreset');
  });
  await page.route(visitUrl + '/wishes', (r) => {
    if (++saves === 1) return r.abort('connectionreset');
    return r.fulfill({ json: { ...visit, wishes: r.request().postDataJSON() } });
  });
  await page.clock.install();
  await page.goto(app.url);
  await page.getByRole('button', { name: /10:00 Strzyżenie, Studio/ }).click();
  const photos = page.getByRole('region', { name: w.photosQ });
  const retry = photos.getByRole('button', { name: pl.retry });
  try {
    await expect.poll(() => reads).toBe(1);
    await page.clock.fastForward(31_000);
    await expect(photos.getByRole('alert')).toHaveText(pl.error.network);
    await retry.click();
    await expect(photos.getByRole('button', { name: 'Usuń: Twoje zdjęcie 1' })).toBeEnabled();
  } finally {
    delayed.resolve();
  }
  await expect(photos.getByRole('alert')).toHaveText(pl.error.network);
  await retry.click();
  await expect(photos.getByRole('img', { name: 'Twoje zdjęcie 1' })).toBeVisible();
  await expect(photos.getByRole('alert')).toHaveCount(0);
  const checkWishes = await chooseWishes(page);
  await page.getByRole('button', { name: w.save }).click();
  await expect(page.getByText(pl.error.network, { exact: true })).toBeVisible();
  await checkWishes();
  await page.getByRole('button', { name: pl.retry }).click();
  await expect(page.getByText(w.saved, { exact: true })).toBeVisible();
  await checkWishes();
  await photos.getByRole('button', { name: 'Usuń: Twoje zdjęcie 1' }).click();
  await expect(photos.getByRole('alert')).toHaveText(pl.error.network);
  await expect(photos.getByRole('img', { name: 'Twoje zdjęcie 1' })).toBeVisible();
  await retry.click();
  await expect(photos).toHaveCount(0);
  expect(deletes).toBe(1);
  expect(saves).toBe(2);
});
