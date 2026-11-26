import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ClientLoyaltyCard, FavoriteSalon } from '../../mobile-client/src/api';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const email = 'client-eb@example.com';
const salon: FavoriteSalon = {
  slug: 'studio-eb',
  name: 'Studio EB',
  addressLine: 'Jasna 1',
  postalCode: '00-001',
  city: 'Warszawa',
  addedAt: '2026-11-25T10:00:00Z',
  timezone: 'Europe/Warsaw',
  todayHours: [],
  bookable: true,
};

test.use({ viewport: { width: 320, height: 700 }, isMobile: true, locale: 'pl-PL' });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

async function restoreSession(page: Page) {
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'eb-test-session'));
  await page.route('**/v1/client/me', (route) => route.fulfill({ json: { email, locale: 'pl' } }));
  await page.route('**/v1/client/appointments?**', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/client/waitlist', (route) => route.fulfill({ json: { items: [] } }));
}

async function expectTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
}

test('rewards render on expansion and reuse the loaded card', async ({ page }) => {
  const card: ClientLoyaltyCard = {
    organization: { id: salon.slug, name: salon.name },
    bookingSlug: salon.slug,
    currency: 'PLN',
    enabled: true,
    mode: 'points',
    balance: 0,
    lifetimeEarned: 0,
    earning: {
      stampsPerVisit: 1,
      pointsPerUnit: 1,
      spendUnitGrosze: 1000,
      minSpendGrosze: 0,
      pointsValidityDays: null,
    },
    next: null,
    rewards: Array.from({ length: 24 }, (_, index) => ({
      id: String(index),
      name: 'Nagroda EB ' + index,
      kind: 'discount_percent',
      discountPercent: 10,
      freeServiceName: null,
      serviceNames: [],
      cost: index + 1,
      missing: index + 1,
      couponValidityDays: null,
    })),
    coupons: [],
    history: [],
    tier: null,
    bonuses: [],
  };
  let reads = 0;
  await restoreSession(page);
  await page.route('**/v1/client/loyalty', (route) => {
    reads++;
    return route.fulfill({ json: { items: [card] } });
  });
  await page.goto(app.url);
  await page.getByRole('tab', { name: t.bonuses.tab }).click();
  const region = page.getByRole('region', { name: salon.name });
  const more = region.getByRole('button', { name: t.catalog.more, exact: true });
  const rewards = region.getByText(/^Nagroda EB \d+$/);
  await expectTarget(
    region.getByRole('button', { name: t.bonuses.book + ': ' + salon.name, exact: true }),
  );
  await expectTarget(more);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(rewards).toHaveCount(0);
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(rewards).toHaveCount(card.rewards.length);
  await expect(rewards.last()).toBeVisible();
  await more.click();
  await expect(rewards).toHaveCount(0);
  expect(reads).toBe(1);
});

test('removing a favorite twice while its response is pending sends one request', async ({
  page,
}) => {
  await restoreSession(page);
  const requests: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/v1/client/favorites', (route) => {
    requests.push(route.request().method());
    return route.fulfill({ json: { items: [salon] } });
  });
  await page.route('**/v1/client/favorites/' + salon.slug, async (route) => {
    requests.push(route.request().method());
    await pending;
    await route.fulfill({ status: 204 });
  });
  try {
    await page.goto(app.url);
    await page.getByRole('tab', { name: t.favorites.tab }).click();
    await expectTarget(
      page.getByRole('button', { name: t.salon.book + ': ' + salon.name, exact: true }),
    );
    await page.getByRole('button', { name: t.catalog.more, exact: true }).click();
    const remove = page.getByRole('button', {
      name: t.favorites.remove + ': ' + salon.name,
      exact: true,
    });
    await expectTarget(remove);
    await remove.evaluate((node: HTMLElement) => {
      node.click();
      node.click();
    });
    await expect(remove).toBeDisabled();
    await expect.poll(() => requests).toEqual(['GET', 'DELETE']);
    release();
    await expect(page.getByText(t.favorites.empty, { exact: true })).toBeVisible();
    expect(requests).toEqual(['GET', 'DELETE']);
  } finally {
    release();
  }
});

test('sign-in works before the directory responds and moves keyboard focus between steps', async ({
  page,
}) => {
  let reads = 0;
  let sends = 0;
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/v1/public/locations?**', async (route) => {
    reads++;
    await pending;
    await route.fulfill({ json: { openNowCount: 3 } });
  });
  await page.route('**/v1/client/auth/code', (route) => {
    sends++;
    return route.fulfill({ json: { codeExpiresAt: '2026-11-27T10:00:00Z' } });
  });
  try {
    await page.goto(app.url);
    const address = page.getByRole('textbox', { name: t.signIn.email, exact: true });
    await expectTarget(address);
    await address.fill(email);
    await address.press('Enter');
    const code = page.getByRole('textbox', { name: t.signIn.code, exact: true });
    await expect(code).toBeFocused();
    await expectTarget(code);
    const contrast = await code.evaluate((node) => {
      const luminance = (css: string) => {
        const [r, g, b] = css.match(/\d+/g)!.map((channel) => {
          const c = Number(channel) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      return (
        (luminance(getComputedStyle(node).backgroundColor) + 0.05) /
        (luminance(getComputedStyle(node, '::placeholder').color) + 0.05)
      );
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: t.signIn.otherEmail }).click();
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(email);
    release();
    await expect(page.getByRole('button', { name: t.catalog.openNow + ' (3)' })).toBeVisible();
    expect([reads, sends]).toEqual([1, 1]);
  } finally {
    release();
  }
});
