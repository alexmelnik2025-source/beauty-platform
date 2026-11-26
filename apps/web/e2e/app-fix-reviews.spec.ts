import { expect, test, type Route } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test('two review settings submissions send one PUT and a failed save can be retried', async ({
  page,
}) => {
  const app = await serveApp('mobile-business');
  try {
    const org = '**/v1/organizations/ea';
    const base = org + '/locations/salon';
    const settings = { enabled: true, requestHours: 3, version: 1 };
    const changes = { ...settings, enabled: false };
    const writes: Route[] = [];
    await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'session'));
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
    await page.route('**/v1/auth/refresh', (route) =>
      route.fulfill({ json: { accessToken: 'session', refreshToken: 'session' } }),
    );
    await page.route('**/v1/me', (route) =>
      route.fulfill({
        json: {
          user: { id: 'owner' },
          organizations: [{ id: 'ea', name: 'Salon', role: 'owner' }],
        },
      }),
    );
    await page.route(org + '/locations', (route) =>
      route.fulfill({
        json: [
          {
            id: 'salon',
            name: 'Salon',
            timezone: 'Europe/Warsaw',
            currency: 'PLN',
            city: 'Warszawa',
          },
        ],
      }),
    );
    await page.route(base + '/reviews', (route) =>
      route.fulfill({
        json: {
          enabled: true,
          count: 0,
          average: null,
          stars: [0, 0, 0, 0, 0],
          unanswered: 0,
          staff: [],
          services: [],
          items: [],
          nextBefore: null,
        },
      }),
    );
    await page.route(base + '/review-settings', (route) => {
      if (route.request().method() === 'PUT') writes.push(route);
      else return route.fulfill({ json: settings });
    });

    await page.goto(app.url);
    await openBusinessMenu(page, pl.reviews.open);
    const heading = page.getByRole('heading', { name: pl.reviews.settings, exact: true });
    const fontSize = () =>
      heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    const originalSize = await fontSize();
    await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
    expect(await fontSize()).toBeCloseTo(originalSize * 1.3, 1);

    const save = page.getByRole('button', { name: pl.reviews.save, exact: true });
    await page.getByRole('button', { name: pl.reviews.dontCollect, exact: true }).click();
    await save.evaluate((element) => {
      (element as HTMLElement).click();
      (element as HTMLElement).click();
    });
    await expect(save).toBeDisabled();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]!.request().postDataJSON()).toEqual(changes);
    await writes[0]!.abort('connectionreset');
    await expect(page.getByRole('alert')).toHaveText(pl.error.network);
    await save.click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]!.request().postDataJSON()).toEqual(changes);
    await writes[1]!.fulfill({ json: { ...changes, version: 2 } });
    await expect(page.getByText(pl.reviews.saved, { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    expect(writes).toHaveLength(2);
  } finally {
    app.server.close();
  }
});
