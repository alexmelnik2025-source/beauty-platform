import { expect, test, type Locator, type Page } from '@playwright/test';
import { pl } from '../../mobile-client/src/locales/pl';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

const salon = { slug: 'studio', name: 'Studio', addressLine: 'Prosta 5', city: 'Warszawa' };
const product = {
  id: 'serum',
  name: 'Serum',
  priceGrosze: 4900,
  available: true,
  photoId: null,
  brand: null,
};
const listed = {
  ...product,
  fromPriceGrosze: 4900,
  offers: [{ ...product, productId: product.id, currency: 'PLN', salon }],
};
const reservation = {
  id: 'pickup',
  productId: product.id,
  name: product.name,
  quantity: 1,
  status: 'reserved',
  totalGrosze: 4900,
};
const pickupUrl = '**/v1/client/appointments/upcoming/products';
const shopUrl = '**/v1/public/shop/products?*';
function pickup(reserved: boolean) {
  return {
    currency: 'PLN',
    canChange: true,
    available: [product],
    reservations: reserved ? [reservation] : [],
    totalGrosze: reserved ? 4900 : 0,
  };
}

async function signedIn(page: Page, scope: 'upcoming' | 'past') {
  const past = scope === 'past';
  const start = new Date(Date.now() + (past ? -7 : 7) * 86400000).toISOString();
  const visit = {
    id: scope,
    salon,
    start,
    date: start.slice(0, 10),
    time: '10:00',
    timezone: 'Europe/Warsaw',
    currency: 'PLN',
    status: past ? 'completed' : 'confirmed',
    coupons: [],
    discountGrosze: 0,
    service: { id: 'cut', name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 7000 },
    staff: { id: 'ola', displayName: 'Ola' },
    canChangeWishes: false,
  };
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await page.route('**/v1/client/me', (r) =>
    r.fulfill({ json: { email: 'client@example.com', locale: 'pl' } }),
  );
  await page.route('**/v1/client/me/summary', (r) => r.fulfill({ json: { completed: 0 } }));
  await page.route('**/v1/client/waitlist', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/v1/client/appointments?scope=*', (r) =>
    r.fulfill({ json: { items: r.request().url().endsWith(scope) ? [visit] : [] } }),
  );
  await page.route('**/v1/client/appointments/' + scope, (r) => r.fulfill({ json: visit }));
  await page.route('**/v1/client/appointments/*/review', (r) =>
    r.fulfill({ json: { canReview: false, review: null } }),
  );
  await page.route('**/v1/client/appointments/*/photos', (r) => r.fulfill({ json: { items: [] } }));
}

// Hold the response until both browser taps and the disabled-state assertion have finished.
function delayedResponse() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function doubleTap(button: Locator, calls: () => number) {
  await button.dblclick();
  await expect(button).toBeDisabled();
  await expect.poll(calls).toBe(1);
}
const retryName = /^Spróbuj ponownie/;

test('a failed next page keeps the catalog and retries that page', async ({ page }) => {
  let secondPageReads = 0;
  await page.route(shopUrl, (r) => {
    const next = new URL(r.request().url()).searchParams.get('page') === '2';
    if (next && ++secondPageReads === 1) return r.abort('connectionreset');
    return r.fulfill({
      json: {
        products: [next ? { ...listed, id: 'mask', name: 'Maska' } : listed],
        page: next ? 2 : 1,
        total: 2,
        pageSize: 1,
      },
    });
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: pl.shop.entry }).click();
  await page.getByRole('button', { name: pl.shop.more }).click();
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await expect(page.getByRole('button', { name: /^Serum,/ })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.getByRole('button', { name: pl.retry }).click();
  await expect(page.getByRole('button', { name: /^Maska,/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Serum,/ })).toHaveCount(1);
  expect(secondPageReads).toBe(2);
});

test('a lost shop confirmation is reconciled without reserving a second piece', async ({
  page,
}) => {
  await signedIn(page, 'upcoming');
  const response = delayedResponse();
  let writes = 0;
  await page.route(shopUrl, (r) =>
    r.fulfill({ json: { products: [listed], page: 1, total: 1, pageSize: 24 } }),
  );
  await page.route(pickupUrl, async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: pickup(writes > 0) });
    expect(r.request().postDataJSON()).toEqual({ productId: product.id, quantity: 1 });
    writes++;
    await response.wait;
    return r.abort('connectionreset');
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: pl.shop.entry }).click();
  await page.getByRole('button', { name: /^Serum,/ }).click();
  const reserve = page.getByRole('button', { name: /^Odbiorę przy wizycie/ });
  await doubleTap(reserve, () => writes);
  response.release();
  const retry = page.getByRole('button', { name: retryName });
  await expect(retry.locator('..').getByRole('alert')).toHaveText(pl.error.network);
  await retry.click();
  await expect(page.getByRole('alert')).toContainText('Odłożone na wizytę');
  expect(writes).toBe(1);
});

test('adding and cancelling a visit product survive a failed refresh and retry once', async ({
  page,
}) => {
  await signedIn(page, 'upcoming');
  const reserve = delayedResponse();
  const cancel = delayedResponse();
  let posts = 0,
    deletes = 0,
    reserved = false,
    offline = false;
  await page.route(pickupUrl, async (r) => {
    if (r.request().method() === 'GET')
      return offline ? r.abort('connectionreset') : r.fulfill({ json: pickup(reserved) });
    expect(r.request().postDataJSON()).toEqual({ productId: product.id, quantity: 1 });
    if (++posts === 1) {
      await reserve.wait;
      offline = true;
      return r.abort('connectionreset');
    }
    reserved = true;
    return r.fulfill({ json: pickup(true) });
  });
  await page.route(pickupUrl + '/' + reservation.id, async (r) => {
    expect(r.request().method()).toBe('DELETE');
    if (++deletes === 1) {
      await cancel.wait;
      offline = true;
      return r.abort('connectionreset');
    }
    reserved = false;
    return r.fulfill({ json: pickup(false) });
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: /Strzyżenie, Studio/ }).click();
  const card = page.getByRole('region', { name: pl.visitProducts.title });
  await card.getByRole('button', { name: pl.visitProducts.add }).click();
  for (const [label, calls, response] of [
    [pl.visitProducts.reserve, () => posts, reserve],
    [pl.visitProducts.giveBack, () => deletes, cancel],
  ] as const) {
    const button = card.getByRole('button', { name: label + ': Serum', exact: true });
    await doubleTap(button, calls);
    response.release();
    const retry = card.getByRole('button', { name: retryName });
    const row = retry.locator('..');
    await expect(row.getByRole('alert')).toHaveText(pl.error.network);
    await expect(retry).toBeEnabled();
    await expect(row.getByText('Serum', { exact: true })).toBeVisible();
    await expect(card.getByRole('progressbar')).toHaveCount(0);
    offline = false;
    await retry.click();
    await expect(card.getByRole('alert')).toHaveCount(0);
    expect(calls()).toBe(2);
  }
  await expect(card.getByRole('button', { name: /^Zrezygnuj/ })).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: pl.visitProducts.reserve + ': Serum' }),
  ).toBeEnabled();
});

test('used products stay visible after disconnection and can be put aside for the next visit', async ({
  page,
}) => {
  await signedIn(page, 'past');
  const response = delayedResponse();
  let writes = 0,
    offline = false;
  const used = (saved: boolean) => ({
    currency: 'PLN',
    products: [{ ...product, reservedForNext: saved }],
    nextVisit: { date: '2030-01-02', time: '10:00' },
  });
  await page.route('**/v1/client/appointments/past/products', (r) =>
    r.fulfill({ json: { ...pickup(false), canChange: false, available: [] } }),
  );
  await page.route('**/v1/client/appointments/past/products/used', (r) =>
    offline ? r.abort('connectionreset') : r.fulfill({ json: used(false) }),
  );
  await page.route('**/v1/client/appointments/past/products/next', async (r) => {
    expect(r.request().postDataJSON()).toEqual({ productId: product.id, quantity: 1 });
    if (++writes === 1) {
      await response.wait;
      offline = true;
      return r.abort('connectionreset');
    }
    return r.fulfill({ json: used(true) });
  });
  await page.goto(app.url);
  await page.getByRole('tab', { name: pl.visits.past }).click();
  await page.getByRole('button', { name: /Strzyżenie, Studio/ }).click();
  const card = page.getByRole('region', { name: pl.visitProducts.usedTitle });
  await doubleTap(
    card.getByRole('button', { name: pl.visitProducts.saveForNext + ': Serum' }),
    () => writes,
  );
  response.release();
  const retry = card.getByRole('button', { name: retryName });
  await expect(retry.locator('..').getByRole('alert')).toHaveText(pl.error.network);
  await expect(retry).toBeEnabled();
  await expect(card.getByText('Serum', { exact: true })).toBeVisible();
  await expect(card.getByRole('progressbar')).toHaveCount(0);
  offline = false;
  await retry.click();
  await expect(card.getByRole('status')).toContainText('Odłożone na wizytę');
  expect(writes).toBe(2);
});
