import { expect, test, type APIRequestContext } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-business/src/i18n';
import { createRoleSalon } from './app-roles-business-fixture';
import { serveApp } from './mobile-app';

let api: APIRequestContext;
let salon: Awaited<ReturnType<typeof createRoleSalon>>;
let app: Awaited<ReturnType<typeof serveApp>>;

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({
    baseURL: process.env.API_URL ?? 'http://localhost:4000',
  });
  salon = await createRoleSalon(api);
  app = await serveApp('mobile-business');
});
test.afterAll(async () => {
  app?.server.close();
  await api?.dispose();
});

for (const locale of ['pl', 'en'] as const) {
  test.describe(locale, () => {
    test.use({ viewport: { width: 320, height: 740 }, isMobile: true, locale });
    const t = DICTIONARIES[locale];
    for (const role of ['owner', 'manager', 'staff'] as const) {
      test(role + ' navigates the salon with its assigned rights', async ({ page }) => {
        const management = role !== 'staff';
        const tokens = await salon.login(role);
        const history = await api.get(salon.base + '/audit-log', {
          headers: { Authorization: 'Bearer ' + tokens.accessToken },
        });
        expect(history.status()).toBe(role === 'owner' ? 200 : 403);
        await page.addInitScript(
          (token) => localStorage.setItem('beauty.business.refreshToken', token),
          tokens.refreshToken,
        );
        // Keep the calendar on the fixture day even if the run crosses midnight in Warsaw.
        await page.clock.setFixedTime(new Date(salon.today + 'T12:00:00Z'));
        await page.goto(app.url);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const tab = (name: string) => page.getByRole('tab', { name, exact: true });
        async function screen(title: string) {
          await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
        }
        await button(t.day.next).click();
        const ownVisit = page.getByRole('button', { name: /EJ Own Client · EJ Cut$/ });
        const otherVisit = page.getByRole('button', { name: /EJ Other Client · EJ Cut$/ });
        await expect(ownVisit).toBeVisible();
        if (management) await expect(otherVisit).toBeVisible();
        else await expect(otherVisit).toHaveCount(0);
        await ownVisit.click();
        await expect(page.getByText(t.visit.status.confirmed, { exact: true })).toBeVisible();
        await button(t.visit.back).click();
        await button(t.week.open).click();
        await screen(t.week.title);
        await button(t.week.back).click();
        await button(t.newVisit.open).click();
        await screen(t.newVisit.title);
        await button(t.newVisit.back).click();
        for (const section of [t.clients, t.shop]) {
          if (management) {
            await tab(section.open).click();
            await screen(section.title);
            if (section === t.shop) {
              await tab(t.navigation.integrations).click();
              await expect(tab(t.navigation.integrations)).toHaveAttribute('aria-selected', 'true');
            }
            await button(section.back).click();
          } else {
            await expect(tab(section.open)).toHaveCount(0);
          }
        }
        await tab(t.navigation.more).click();
        const menu = [
          [t.notifications, true],
          [t.services, management],
          [t.happyHours, management],
          [t.team, management],
          [
            { open: t.schedule.teamOpen, title: t.schedule.teamTitle, back: t.schedule.back },
            management,
          ],
          [t.schedule, !management],
          [t.reports, management],
          [t.loyalty, management],
          [t.guard, management],
          [t.reviews, true],
          [t.vouchers, true],
          [t.history, role === 'owner'],
          [t.bookingLink, management],
          [t.messages, management],
          [
            { open: t.navigation.settings, title: t.navigation.settings, back: t.salon.back },
            management,
          ],
          [t.profile, !management],
        ] as const;
        for (const [section, allowed] of menu) {
          await test.step(section.open, async () => {
            if (!allowed) {
              await expect(button(section.open)).toHaveCount(0);
              return;
            }
            await button(section.open).click();
            await screen(section.title);
            if (section === t.vouchers) {
              await expect(button(t.vouchers.check)).toBeEnabled();
              if (management) await expect(button(t.vouchers.sell)).toBeEnabled();
              else await expect(button(t.vouchers.sell)).toHaveCount(0);
            }
            await button(section.back).click();
            await expect(tab(t.navigation.more)).toHaveAttribute('aria-selected', 'true');
          });
        }
      });
    }
  });
}
