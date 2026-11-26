import { expect, test } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-business/src/i18n';
import { expectAuditTextFits, installAuditSession, scaleAuditText } from './audit-business';
import { serveApp } from './mobile-app';

let app: Awaited<ReturnType<typeof serveApp>>;

test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());

for (const [lang, locale] of [
  ['pl', 'pl-PL'],
  ['en', 'en-GB'],
  ['uk', 'uk-UA'],
  ['ru', 'ru-RU'],
] as const) {
  test.describe(locale, () => {
    test.use({ locale, isMobile: true, viewport: { width: 320, height: 740 } });
    for (const role of ['owner', 'manager', 'staff'] as const) {
      test(`${role} can recover the saved session after an offline start`, async ({ page }) => {
        const t = DICTIONARIES[lang];
        await installAuditSession(page, role);
        let attempts = 0;
        await page.route('**/v1/auth/refresh', async (route) => {
          if (++attempts === 1) await route.abort('internetdisconnected');
          else await route.fallback();
        });
        await page.goto(app.url);
        const message = page.getByRole('alert');
        await expect(message).toHaveText(t.error.network);
        await scaleAuditText(page, message);
        await expectAuditTextFits(message);
        const retry = page.getByRole('button', { name: t.day.refresh, exact: true });
        await expectAuditTextFits(retry.getByText(t.day.refresh, { exact: true }));
        await retry.click();
        const tab = (name: string) => page.getByRole('tab', { name, exact: true });
        await expect(tab(t.navigation.calendar)).toHaveAttribute('aria-selected', 'true');
        await expect(tab(t.clients.open)).toHaveCount(role === 'staff' ? 0 : 1);
        await expect(tab(t.shop.open)).toHaveCount(role === 'staff' ? 0 : 1);
        await tab(t.navigation.more).click();
        const item = (name: string) => page.getByRole('button', { name, exact: true });
        await expect(item(t.history.open)).toHaveCount(role === 'owner' ? 1 : 0);
        await expect(item(t.navigation.settings)).toHaveCount(role === 'staff' ? 0 : 1);
        await expect(item(t.notifications.open)).toBeVisible();
        expect(attempts).toBe(2);
      });
    }
  });
}
