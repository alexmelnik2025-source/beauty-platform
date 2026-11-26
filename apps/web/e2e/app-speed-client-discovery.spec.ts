import { expect, test, type Route } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 700 }, isMobile: true, locale: 'pl-PL' });

test('booking reuses a pending salon load, allows a retry and ignores a reply after Back', async ({
  page,
}) => {
  const app = await serveApp('mobile-client');
  const t = DICTIONARIES.pl;
  const salon = {
    slug: 'studio-eb',
    name: 'Studio EB',
    timezone: 'Europe/Warsaw',
    bookable: true,
    todayHours: [],
    currency: 'PLN',
    addressLine: 'ul. Prosta 4',
    postalCode: '00-001',
    city: 'Warszawa',
    categories: [],
    services: [],
    staff: [],
  };
  const pending: Route[] = [];
  try {
    await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'test-client'));
    await page.route('**/v1/client/me', (route) =>
      route.fulfill({ json: { email: 'eb@example.test', locale: 'pl' } }),
    );
    await page.route('**/v1/client/appointments?scope=*', (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.route('**/v1/client/waitlist', (route) => route.fulfill({ json: { items: [] } }));
    await page.route('**/v1/client/favorites', (route) =>
      route.fulfill({ json: { items: [salon] } }),
    );
    await page.route('**/v1/public/locations?*', (route) =>
      route.fulfill({
        json: {
          items: [],
          total: 0,
          page: 1,
          pageCount: 1,
          languageCounts: {},
          specialtyCounts: {},
          openNowCount: 0,
        },
      }),
    );
    await page.route('**/v1/public/locations/studio-eb', (route) => {
      pending.push(route);
    });
    await page.goto(app.url);
    await expect(page.getByText(t.visits.emptyUpcoming, { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: t.favorites.tab }).click();
    const book = page.getByRole('button', { name: new RegExp('^' + t.salon.book) });
    const back = page.getByRole('button', { name: t.book.back, exact: true });
    const loading = page.getByRole('progressbar', { name: t.loading, exact: true });

    await book.click();
    await expect(loading).toBeVisible();
    await expect(page.getByRole('heading', { name: salon.name, exact: true })).toBeVisible();
    await expect.poll(() => pending.length).toBe(1);
    const bounds = await back.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);

    await back.click();
    await book.click();
    await expect(loading).toBeVisible();
    await pending[0]!.fulfill({ status: 503, json: {} });
    const retry = page.getByRole('button', { name: t.retry, exact: true });
    await expect(retry).toBeVisible();
    expect(pending).toHaveLength(1);
    await retry.click();
    await expect.poll(() => pending.length).toBe(2);

    await back.click();
    const previousReply = page.waitForEvent('requestfinished', (r) => r === pending[1]!.request());
    await pending[1]!.fulfill({ json: salon });
    await previousReply;
    await expect(book).toBeVisible();

    await book.click();
    await expect.poll(() => pending.length).toBe(3);
    await pending[2]!.fulfill({ json: salon });
    await expect(page.getByRole('heading', { name: t.book.pickService })).toBeVisible();
    expect(pending).toHaveLength(3);
  } finally {
    app.server.close();
  }
});
