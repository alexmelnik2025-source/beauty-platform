import { expect, test } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 700 }, isMobile: true, locale: 'pl-PL' });

test('typing, returning from the catalogue and changing language reuse sign-in data', async ({
  page,
}) => {
  const app = await serveApp('mobile-client');
  const { pl, en } = DICTIONARIES;
  const salon = { slug: 'studio-cm', name: 'Studio CM' };
  const email = 'cm@example.com';
  const requests: string[] = [];
  try {
    await page.addInitScript((salon) => {
      const key = 'beauty.catalog.recent';
      localStorage.setItem(key, JSON.stringify([salon]));
      const getItem = Storage.prototype.getItem;
      let reads = 0;
      Storage.prototype.getItem = function (name) {
        if (this === localStorage && name === key)
          document.documentElement.dataset.recentReads = String(++reads);
        return getItem.call(this, name);
      };
    }, salon);
    await page.route('**/v1/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/v1/public/locations') {
        requests.push(url.searchParams.get('pageSize') === '1' ? 'open count' : 'catalogue');
        return route.fulfill({
          json: {
            items: [],
            total: 0,
            page: 1,
            pageCount: 1,
            languageCounts: {},
            specialtyCounts: {},
            openNowCount: 3,
          },
        });
      }
      requests.push(url.pathname);
      if (url.pathname === '/v1/client/auth/code') return route.fulfill({ json: {} });
      return route.abort();
    });
    await page.goto(app.url);
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const textbox = (name: string) => page.getByRole('textbox', { name, exact: true });
    const recent = (name: string) => page.getByRole('group', { name, exact: true });
    await expect(recent(pl.catalog.recent).getByRole('button', { name: salon.name })).toBeVisible();
    await expect(button(pl.catalog.openNow + ' (3)')).toBeVisible();
    await textbox(pl.signIn.email).pressSequentially(email);
    await button(pl.signIn.sendCode).click();
    await textbox(pl.signIn.code).pressSequentially('123456');
    await expect(button(pl.signIn.confirm)).toBeEnabled();

    await button(pl.catalog.title).click();
    await expect(page.getByText(pl.catalog.empty, { exact: true })).toBeVisible();
    await button(pl.salon.back).click();
    await expect(textbox(pl.signIn.code)).toHaveValue('123456');
    await expect(recent(pl.catalog.recent).getByRole('button', { name: salon.name })).toBeVisible();

    await button(pl.language).click();
    await button('English').click();
    await expect(textbox(en.signIn.code)).toHaveValue('123456');
    await expect(button(en.catalog.openNow + ' (3)')).toBeVisible();
    const translated = recent(en.catalog.recent);
    await expect(translated.getByRole('button', { name: salon.name })).toBeVisible();
    await translated.getByRole('button', { name: en.catalog.recentClear }).click();
    await expect(translated).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-recent-reads', '1');
    expect(requests).toEqual(['open count', '/v1/client/auth/code', 'catalogue']);
  } finally {
    app.server.close();
  }
});
