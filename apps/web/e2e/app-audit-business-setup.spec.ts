import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-business/src/i18n';
import {
  auditBase,
  expectAuditTextFits,
  installAuditSession,
  scaleAuditText,
} from './audit-business';
import { serveApp } from './mobile-app';

let preview: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  preview = await serveApp('mobile-business');
});
test.afterAll(() => {
  preview?.server.close();
});

// Keep the request pending until both clicks have reached the browser. Abort at the
// transport layer so the app sees a failed fetch, not a server validation message.
async function checkOfflineSave(page: Page, button: Locator, path: string, error: string) {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const url = '**' + path;
  await page.route(url, async (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    calls++;
    await gate;
    await route.abort('internetdisconnected');
  });
  try {
    // Keep both physical clicks inside the button when its label switches to a spinner.
    await button.dblclick({ position: { x: 12, y: 18 } });
    await expect.poll(() => calls).toBe(1);
    await expect(button).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('alert').filter({ hasText: error }).first()).toBeVisible();
  await expect(button).toBeEnabled();
  expect(calls).toBe(1);
}

for (const locale of ['pl', 'en', 'uk', 'ru'] as const) {
  const t = DICTIONARIES[locale];
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 740 }, isMobile: true });

    test('new salon preserves the company when creating the first location fails', async ({
      page,
    }) => {
      await installAuditSession(page, 'owner');
      await page.route('**/v1/me', (route) =>
        route.fulfill({ json: { user: { id: 'user' }, organizations: [] } }),
      );
      let companies = 0;
      await page.route('**/v1/organizations', (route) => {
        companies++;
        return route.fulfill({ json: { id: 'new' } });
      });
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      await page.goto(preview.url);
      await scaleAuditText(page, page.getByRole('heading', { name: t.salons.title }));
      await button(t.salons.create).click();
      await expectAuditTextFits(page.getByRole('heading', { name: t.newSalon.title }));
      await button(t.newSalon.create).dblclick();
      await expect(page.getByLabel(t.newSalon.orgName, { exact: true })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await page.getByLabel(t.newSalon.orgName, { exact: true }).fill('Studio DR');
      await page.getByLabel(t.salon.address, { exact: true }).fill('Bema 91');
      await page.getByLabel(t.salon.city, { exact: true }).fill('Warszawa');
      await page.getByLabel(t.salon.postalCode, { exact: true }).fill('01233');
      await checkOfflineSave(
        page,
        button(t.newSalon.create),
        '/v1/organizations/new/locations',
        t.error.network,
      );
      await expect(page.getByLabel(t.newSalon.orgName, { exact: true })).not.toBeEditable();
      await expect(page.getByLabel(t.salon.city, { exact: true })).toHaveValue('Warszawa');
      const retry = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().endsWith('/new/locations'),
      );
      await button(t.newSalon.create).click();
      expect((await retry).postDataJSON()).toMatchObject({
        name: 'Studio DR',
        defaultLocale: locale,
        postalCode: '01-233',
      });
      expect(companies).toBe(1);
    });

    for (const role of ['owner', 'manager', 'staff'] as const) {
      test(
        role + ' sees the permitted shop and settings screens, empty content and failed saves',
        async ({ page }) => {
          await installAuditSession(page, role);
          const button = (name: string) => page.getByRole('button', { name, exact: true });
          const heading = (name: string) => page.getByRole('heading', { name, exact: true });
          const tab = (name: string) => page.getByRole('tab', { name, exact: true });
          const text = (value: string) => page.getByText(value, { exact: true });
          const input = (name: string) => page.getByRole('textbox', { name, exact: true });
          const empty: Record<string, unknown> = {
            [auditBase + '/photos']: [],
            [auditBase + '/services']: [],
            [auditBase + '/service-categories']: [],
            [auditBase + '/staff-prices']: { prices: [], durations: [] },
            [auditBase + '/happy-hours']: { rules: [] },
            [auditBase + '/products']: { products: [], sold30Days: [] },
            [auditBase + '/shop/integrations/base']: { connected: false },
            [auditBase + '/staff/staff/working-hours']: {
              timezone: 'Europe/Warsaw',
              weekly: [],
              overrides: [],
            },
            [auditBase + '/staff/staff/time-off']: [],
            '/v1/organizations/org/members': [],
            '/v1/organizations/org/invitations': [],
          };
          await page.route('**/v1/**', (route) => {
            const path = new URL(route.request().url()).pathname;
            return route.request().method() === 'GET' && Object.hasOwn(empty, path)
              ? route.fulfill({ json: empty[path] })
              : route.fallback();
          });
          await page.goto(preview.url);
          await tab(t.navigation.more).click();
          await scaleAuditText(page, heading(t.navigation.more));
          if (role === 'staff') {
            await button(t.schedule.open).click();
            await expectAuditTextFits(heading(t.schedule.title));
          } else {
            await button(t.schedule.teamOpen).click();
            await button('Anna').click();
            await expectAuditTextFits(heading(fill(t.schedule.staffTitle, { name: 'Anna' })));
            await expect(text(t.staffProfile.noBio)).toBeVisible();
          }
          await expect(text(t.schedule.dayOff)).toHaveCount(7);
          await expect(text(t.schedule.noTimeOff)).toBeVisible();
          if (role === 'staff') {
            await expect(text(t.schedule.readOnly)).toBeVisible();
            await expect(button(t.schedule.editWeek)).toHaveCount(0);
            await button(t.schedule.back).click();
            for (const name of [
              t.services.open,
              t.happyHours.open,
              t.team.open,
              t.schedule.teamOpen,
              t.navigation.settings,
            ])
              await expect(button(name)).toHaveCount(0);
            await expect(tab(t.shop.open)).toHaveCount(0);
            // A read-only specialist can encounter the same transport failure on opening the schedule.
            await page.route('**/working-hours', (route) => route.abort('internetdisconnected'));
            await button(t.schedule.open).dblclick();
            await expect(page.getByRole('alert')).toHaveText(t.error.network);
            return;
          }

          await button(t.staffProfile.edit).click();
          await input(t.staffProfile.name).fill('Anna DR');
          await checkOfflineSave(
            page,
            button(t.staffProfile.save),
            auditBase + '/staff/staff',
            t.error.network,
          );
          await expect(input(t.staffProfile.name)).toHaveValue('Anna DR');
          await button(t.staffProfile.cancel).click();

          await button(t.schedule.add).click();
          await input(t.schedule.note).fill('DR');
          await checkOfflineSave(
            page,
            button(t.schedule.save),
            auditBase + '/staff/staff/time-off',
            t.error.network,
          );
          await expect(input(t.schedule.note)).toHaveValue('DR');
          await button(t.schedule.back).click();
          await button(t.schedule.back).click();
          empty[auditBase + '/staff'] = [];

          await button(t.services.open).click();
          await expectAuditTextFits(heading(t.services.title));
          await expect(text(t.services.none)).toBeVisible();
          await button(t.services.addService).click();
          await input(t.services.name).fill('Consultation');
          await input(fill(t.services.price, { currency: 'PLN' })).fill('50');
          await checkOfflineSave(
            page,
            button(t.services.save),
            auditBase + '/services',
            t.error.network,
          );
          await expect(input(t.services.name)).toHaveValue('Consultation');
          await button(t.services.back).click();

          await button(t.team.open).click();
          await expectAuditTextFits(heading(t.team.title));
          await expect(text(t.team.none)).toBeVisible();
          await button(t.team.newPerson).click();
          await input(t.team.email).fill('audit@example.test');
          await checkOfflineSave(
            page,
            button(t.team.send),
            '/v1/organizations/org/invitations',
            t.error.network,
          );
          await expect(input(t.team.email)).toHaveValue('audit@example.test');
          await button(t.team.back).click();

          await button(t.schedule.teamOpen).click();
          await expectAuditTextFits(heading(t.schedule.teamTitle));
          await expect(text(t.schedule.noStaff)).toBeVisible();
          await button(t.staffProfile.add).click();
          await input(t.staffProfile.newName).fill('Alex');
          await checkOfflineSave(
            page,
            button(t.staffProfile.create),
            auditBase + '/staff',
            t.error.network,
          );
          await expect(input(t.staffProfile.newName)).toHaveValue('Alex');
          await button(t.schedule.back).click();

          await button(t.happyHours.open).click();
          await expectAuditTextFits(heading(t.happyHours.title));
          await expect(text(t.happyHours.empty)).toBeVisible();
          await button(t.happyHours.add).click();
          await button(t.happyHours.lastMinute).click();
          await input(t.happyHours.lastMinuteHours).fill('12');
          await input(t.happyHours.percent).fill('20');
          await checkOfflineSave(
            page,
            button(t.happyHours.save),
            auditBase + '/happy-hours',
            t.error.network,
          );
          await expect(input(t.happyHours.percent)).toHaveValue('20');
          await button(t.happyHours.back).click();

          await button(t.navigation.settings).click();
          await expectAuditTextFits(heading(t.navigation.settings));
          for (const section of [
            t.salon.online,
            t.salon.languages,
            t.salon.country,
            t.salon.rules,
            t.salon.questions,
            t.salon.legal,
            t.salon.photos,
          ]) {
            await button(section).click();
            await expectAuditTextFits(heading(section));
            if (section === t.salon.photos) await expect(text(t.salon.photosNone)).toBeVisible();
            await button('‹ ' + t.navigation.settings).click();
          }
          await button(t.navigation.salonDetails).click();
          await expectAuditTextFits(heading(t.navigation.salonDetails));
          await input(t.salon.name).fill('Studio DR 2');
          await checkOfflineSave(page, button(t.salon.save), auditBase, t.error.network);
          await expect(input(t.salon.name)).toHaveValue('Studio DR 2');
          await button(t.navigation.discard).click();
          await button('‹ ' + t.navigation.settings).click();
          await button(t.salon.back).click();

          await tab(t.shop.open).click();
          await expectAuditTextFits(heading(t.shop.title));
          await expect(text(t.products.empty)).toBeVisible();
          await tab(t.navigation.integrations).click();
          await expect(text(t.shop.base.off)).toBeVisible();
          await tab(t.navigation.online).click();
          await expect(text(t.shop.empty)).toBeVisible();
          await tab(t.navigation.products).click();
          await button(t.products.add).click();
          await input(t.products.newName).fill('Pomade');
          await input(fill(t.products.priceIn, { currency: 'PLN' })).fill('45');
          await checkOfflineSave(
            page,
            button(t.products.save),
            auditBase + '/products',
            t.error.network,
          );
          await expect(input(t.products.newName)).toHaveValue('Pomade');
          await button(t.products.cancel).click();
          await tab(t.navigation.online).click();
          empty[auditBase + '/products'] = {
            products: [
              {
                id: 'wax',
                name: 'Wax',
                supplier: null,
                active: true,
                stockQuantity: 1,
                priceGrosze: 5000,
                lowStockAt: null,
                purchasePriceGrosze: null,
                barcode: null,
                catalogProductId: null,
              },
            ],
            sold30Days: [],
          };
          await tab(t.navigation.products).click();
          await button(t.navigation.inventory + ' ▸').click();
          await button(t.products.stocktake).click();
          const count = input(fill(t.products.stocktakeCount, { name: 'Wax' }));
          await count.fill('2');
          await checkOfflineSave(
            page,
            button(t.products.stocktakeSave),
            auditBase + '/products/stocktake',
            t.error.network,
          );
          await expect(count).toHaveValue('2');
          await button(t.products.stocktake).click();
          await button(t.products.delivery).click();
          const arrived = input(fill(t.products.deliveryCame, { name: 'Wax' }));
          await arrived.fill('3');
          await checkOfflineSave(
            page,
            button(fill(t.products.deliverySave, { n: '3' })),
            auditBase + '/products/delivery',
            t.error.network,
          );
          await expect(arrived).toHaveValue('3');
        },
      );
    }
  });
}
