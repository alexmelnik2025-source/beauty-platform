import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, LOCALES } from '../../mobile-business/src/i18n';
import {
  auditBase,
  expectAuditTextFits,
  installAuditSession,
  scaleAuditText,
} from './audit-business';
import { serveApp } from './mobile-app';

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());

const atSalon = '**' + auditBase;
const loyalty = '**/v1/organizations/org/loyalty';
const program = {
  enabled: false,
  mode: 'stamps',
  stampsPerVisit: 1,
  pointsPerUnit: 1,
  spendUnitGrosze: 100,
  minSpendGrosze: 0,
  maxDiscountPercent: 100,
  pointsValidityDays: null,
  allowStacking: false,
  marketplaceEnabled: false,
  version: 1,
  earnRules: [],
};
const guard = {
  enabled: true,
  maxChanges: 3,
  windowHours: 720,
  lateCancelMinutes: null,
  maxNoShows: null,
  action: 'approval',
  version: 1,
};

function emptyReport(url: URL, own: boolean) {
  return {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    scope: own ? 'own' : 'location',
    location: { currency: 'PLN' },
    totals: {
      visits: 0,
      paid: 0,
      revenueGrosze: 0,
      averageTicketGrosze: 0,
      completed: 0,
      upcoming: 0,
      noShow: 0,
      cancelledByClient: 0,
      cancelledBySalon: 0,
      clients: 0,
      newClients: 0,
      online: 0,
    },
    staff: [],
    weekdays: [],
    days: [],
    payments: [],
    busyHours: [],
    topClients: [],
    unbookedServices: [],
    tips: { totalGrosze: 0, staff: [] },
    products: { totalGrosze: 0 },
    writeOffs: { quantity: 0 },
    deliveries: { quantity: 0 },
    stocktakes: { missingQuantity: 0, extraQuantity: 0 },
    idleProducts: { items: [] },
    giftVouchers: { sold: 0, payments: 0, activeBalanceGrosze: 0, expired: 0 },
    discounts: { totalGrosze: 0 },
    tillCloses: { days: [] },
    leadTime: { visits: 0 },
    cancelNotice: { cancelled: 0 },
    channels: { online: 0 },
    occupancy: { staff: [] },
    rebooking: { clients: 0 },
    newcomers: { clients: 0 },
    returnInterval: { intervals: 0 },
    marketing: { clients: 0 },
  };
}

// Disconnect only after the second tap so a premature re-enable cannot hide a duplicate request.
async function doubleTapOffline(page: Page, control: Locator, path: string) {
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let calls = 0;
  await page.route(path, async (route) => {
    calls++;
    await held;
    await route.abort('internetdisconnected');
  });
  try {
    await control.dblclick();
    await expect(control).toBeDisabled();
    await expect.poll(() => calls).toBe(1);
  } finally {
    release();
  }
  await expect(control).toBeEnabled();
  expect(calls).toBe(1);
}

for (const locale of LOCALES) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 740 }, isMobile: true });
    for (const role of ['owner', 'manager', 'staff'] as const) {
      test(`${role} — vouchers, reports, loyalty and cancellation guard at 130%`, async ({
        page,
      }) => {
        await installAuditSession(page, role, { viewOwnEarnings: true });
        const t = DICTIONARIES[locale];
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const heading = (name: string) => page.getByRole('heading', { name, exact: true });
        const text = (value: string) => page.getByText(value, { exact: true });
        const reply = (path: string, json: unknown) =>
          page.route(path, (route) => route.fulfill({ json }));
        await reply(atSalon + '/gift-vouchers', {
          vouchers: [],
          activeBalanceGrosze: 0,
          expiringSoon: { count: 0 },
        });
        await reply(loyalty + '/program', program);
        await reply(loyalty + '/rewards', []);
        await reply(loyalty + '/transactions?*', []);
        await reply(loyalty + '/tiers', { tiers: [], basis: 'visits', periodDays: 90 });
        await reply(loyalty + '/bonus-rules', { rules: [] });
        await reply(atSalon + '/services', []);
        await reply(atSalon + '/cancellation-guard', guard);
        await reply(atSalon + '/cancellation-guard/clients', { items: [], currency: 'PLN' });
        await reply(atSalon + '/reports/commissions', { staff: [] });
        await page.route(atSalon + '/reports?*', (route) =>
          route.fulfill({ json: emptyReport(new URL(route.request().url()), role === 'staff') }),
        );
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await page.getByRole('tab', { name: t.navigation.more, exact: true }).click();

        await button(t.vouchers.open).click();
        await scaleAuditText(page, heading(t.vouchers.title));
        await expectAuditTextFits(heading(t.vouchers.title));
        const code = page.getByLabel(t.vouchers.code, { exact: true });
        await code.fill('TESTCODE');
        await doubleTapOffline(
          page,
          button(t.vouchers.check),
          atSalon + '/gift-vouchers/code/TESTCODE',
        );
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        await expect(code).toHaveValue('TESTCODE');
        if (role === 'staff') {
          await expect(button(t.vouchers.sell)).toHaveCount(0);
          await expect(heading(t.vouchers.listTitle)).toHaveCount(0);
        } else {
          await expectAuditTextFits(text(t.vouchers.empty));
          const amount = page.getByLabel(t.vouchers.amount, { exact: true });
          await amount.fill('19,50');
          await doubleTapOffline(page, button(t.vouchers.sell), atSalon + '/gift-vouchers');
          await expect(amount).toHaveValue('19,50');
          await expect(page.getByRole('alert').filter({ hasText: t.error.network })).toHaveCount(2);
        }
        await button(t.vouchers.back).click();

        await button(t.reports.open).click();
        await expectAuditTextFits(heading(t.reports.title));
        await expectAuditTextFits(text(t.reports.empty));
        if (role === 'staff') {
          await expect(text(t.reports.ownHint)).toBeVisible();
          await expect(button(t.reports.commissionsSet)).toHaveCount(0);
        } else {
          await button(t.reports.commissionsSet).click();
          await expect(button(t.reports.commissionsHide)).toBeVisible();
        }
        let periodReads = 0;
        await page.route(atSalon + '/reports?*', (route) => {
          periodReads++;
          return route.abort('internetdisconnected');
        });
        await button(t.reports.lastMonth).dblclick();
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        expect(periodReads).toBe(1);
        await expect(text(t.reports.empty)).toHaveCount(0);
        await button(t.reports.back).click();

        if (role === 'staff') {
          await expect(button(t.guard.open)).toHaveCount(0);
          await expect(button(t.loyalty.open)).toHaveCount(0);
          return;
        }
        await button(t.guard.open).click();
        await expectAuditTextFits(heading(t.guard.title));
        await expectAuditTextFits(text(t.guard.none));
        await button(t.guard.rulesChange).click();
        await doubleTapOffline(page, button(t.guard.rulesSave), atSalon + '/cancellation-guard');
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        await expect(page.getByLabel(t.guard.changes, { exact: true })).toHaveValue('3');
        await button(t.guard.back).click();

        await button(t.loyalty.open).click();
        await expectAuditTextFits(heading(t.loyalty.title));
        for (const message of [
          t.loyalty.noRewards,
          t.loyalty.noHistory,
          t.loyalty.noServices,
          t.loyalty.bonusNone,
          t.loyalty.tiersNone,
        ]) {
          await expectAuditTextFits(text(message));
        }
        await doubleTapOffline(page, button(t.loyalty.turnOn), loyalty + '/program');
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        for (const [edit, add] of [
          [t.loyalty.tiersChange, t.loyalty.tierAdd],
          [t.loyalty.bonusChange, t.loyalty.bonusAdd],
        ] as const) {
          await button(edit).click();
          await expectAuditTextFits(button(add));
          await button(add).click();
          await button(t.loyalty.cancel).click();
        }
        await button(t.loyalty.add).click();
        await page.getByLabel(t.loyalty.name, { exact: true }).fill('Welcome');
        const percent = page.getByLabel(t.loyalty.percent, { exact: true });
        await percent.fill('1e2');
        await page.getByLabel(t.loyalty.costStamps, { exact: true }).fill('5');
        await button(t.loyalty.save).click();
        await expect(percent).toHaveAttribute('aria-invalid', 'true');
        await expect(page.getByRole('alert')).toContainText(t.loyalty.problem.percent);
        await percent.fill('25');
        await page.route(loyalty + '/rewards', (route) => route.abort('internetdisconnected'));
        await button(t.loyalty.save).click();
        await expect(page.getByRole('alert')).toContainText(t.error.network);
        await expect(page.getByLabel(t.loyalty.name, { exact: true })).toHaveValue('Welcome');
      });
    }
  });
}
