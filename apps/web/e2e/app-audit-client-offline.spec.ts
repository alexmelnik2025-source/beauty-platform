import { expect, test } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { auditLocales, enlargeText, expectFits } from './app-audit-client-fixture';
import { serveApp } from './mobile-app';

const slug = 'sfera';
const serviceId = 'd0000000-0000-4000-8000-000000000001';
const staffId = 'd0000000-0000-4000-8000-000000000002';
const salon = {
  slug,
  name: 'Sfera',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  services: [
    {
      id: serviceId,
      name: 'Loki',
      durationMinutes: 30,
      priceGrosze: 8000,
      priceFromGrosze: 8000,
      priceToGrosze: 8000,
    },
  ],
  staff: [
    { id: 'other', displayName: 'Ola', serviceIds: [serviceId], prices: [], languages: [] },
    { id: staffId, displayName: 'Ewa', serviceIds: [serviceId], prices: [], languages: [] },
  ],
  categories: [],
};

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

for (const locale of auditLocales) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 700 }, isMobile: true });
    test('a booking link keeps its service and specialist when a failed hold is retried', async ({
      page,
      context,
    }) => {
      const t = DICTIONARIES[locale];
      const base = '**/v1/public/locations/' + slug;
      const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const slot = { start: date + 'T09:00:00Z', date, time: '10:00', staffIds: [staffId] };
      await page.route(base, (route) => route.fulfill({ json: salon }));
      await page.route(base + '/availability?*', (route) =>
        route.fulfill({ json: { slots: [slot] } }),
      );
      await page.goto(
        app.url + '/' + locale + '/b/' + slug + '?service=' + serviceId + '&staff=' + staffId,
      );
      await enlargeText(page.getByRole('heading', { name: t.book.pickTime }));
      const time = page.getByRole('button', { name: slot.time, exact: true });
      await expectFits(time);

      // Let the browser itself reject this request. Install the successful response only after reconnecting.
      await context.setOffline(true);
      const holdPath = '/v1/public/locations/' + slug + '/holds';
      const failed = page.waitForEvent('requestfailed', (request) =>
        request.url().endsWith(holdPath),
      );
      await time.click();
      const first = await failed;
      expect(first.failure()?.errorText).toContain('ERR_INTERNET_DISCONNECTED');
      const alert = page.getByRole('alert');
      await expect(alert).toHaveText(t.error.network);
      await expectFits(alert);
      const key = first.headers()['idempotency-key'];
      expect(key).toBeTruthy();
      expect(first.postDataJSON()).toEqual({
        serviceId,
        staffId,
        start: slot.start,
        channel: 'app',
      });

      await context.setOffline(false);
      await page.route(base + '/holds', (route) =>
        route.fulfill({
          json: {
            ...slot,
            holdId: 'time-hold',
            holdToken: 'held',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            serviceName: 'Loki',
            staffName: 'Ewa',
            priceGrosze: 8000,
            currency: 'PLN',
          },
        }),
      );
      const retried = page.waitForRequest((request) => request.url().endsWith(holdPath));
      await page.getByRole('button', { name: t.retry }).click();
      const second = await retried;
      expect(second.headers()['idempotency-key']).toBe(key);
      expect(second.postDataJSON()).toEqual(first.postDataJSON());
      await expect(page.getByRole('textbox', { name: t.book.name, exact: true })).toBeVisible();
      await expect(alert).toHaveCount(0);
    });
  });
}
