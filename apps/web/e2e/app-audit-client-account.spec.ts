import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { ClientLoyaltyCard, FavoriteSalon } from '../../mobile-client/src/api';
import { DICTIONARIES, LANGUAGE_NAMES } from '../../mobile-client/src/i18n';
import { auditLocales, enlargeText, expectFits } from './app-audit-client-fixture';
import { serveApp } from './mobile-app';

const email = 'audit@example.com';
const emptyList = { items: [] };
const summary = { completed: 0, salons: 0, firstVisitAt: null, spent: [] };
const favorite: FavoriteSalon = {
  slug: 'audit-studio',
  name: 'Studio DQ',
  addressLine: 'Prosta 1',
  city: 'Warszawa',
  postalCode: '00-001',
  bookable: false,
  addedAt: '2026-11-25T12:00:00Z',
  timezone: 'Europe/Warsaw',
  todayHours: [],
};
const loyalty: ClientLoyaltyCard = {
  organization: { id: 'audit-studio', name: 'Studio DQ' },
  bookingSlug: 'audit-studio',
  enabled: true,
  mode: 'stamps',
  currency: 'PLN',
  balance: 1,
  lifetimeEarned: 1,
  earning: {
    stampsPerVisit: 1,
    pointsPerUnit: 0,
    spendUnitGrosze: 0,
    minSpendGrosze: 0,
    pointsValidityDays: null,
  },
  next: null,
  tier: null,
  rewards: [],
  coupons: [],
  bonuses: [],
  history: [
    {
      id: 'history',
      type: 'earn',
      points: 1,
      balanceAfter: 1,
      serviceName: 'Strzyżenie',
      createdAt: '2026-11-24T12:00:00Z',
      expiresAt: null,
    },
  ],
};
let app: Awaited<ReturnType<typeof serveApp>>;

test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

async function doubleTap(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await control.evaluate((node: HTMLElement) => {
    node.click();
    node.click();
  });
}

async function saveSession(page: Page) {
  // Store the session on the preview's origin before mounting the app.
  await page.goto(app.url + '/metadata.json');
  await page.evaluate(() => localStorage.setItem('beauty.client.session', 'audit-client'));
}

async function getEmptyAccount(page: Page) {
  for (const path of ['/appointments?scope=*', '/waitlist', '/favorites', '/loyalty']) {
    await page.route('**/v1/client' + path, (route) => route.fulfill({ json: emptyList }));
  }
  await page.route('**/v1/client/me/summary', (route) => route.fulfill({ json: summary }));
}

for (const locale of auditLocales) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 568 }, isMobile: true });

    test('sign-in retains the confirmation code through a lost response and a double tap', async ({
      page,
    }) => {
      const t = DICTIONARIES[locale];
      const person = { email, locale, id: 'audit-client' };
      await getEmptyAccount(page);
      await page.route('**/v1/public/locations?*', (route) =>
        route.fulfill({ json: { items: [], total: 0, openNowCount: 0 } }),
      );
      const codeRequests: unknown[] = [];
      await page.route('**/v1/client/auth/code', (route) => {
        codeRequests.push(route.request().postDataJSON());
        return route.fulfill({ json: { codeExpiresAt: '2026-11-26T12:50:00Z' } });
      });
      // Keep verification pending while checking the controls, then disconnect it.
      let verification: Route | undefined;
      const attempts: unknown[] = [];
      await page.route('**/v1/client/auth/verify', (route) => {
        attempts.push(route.request().postDataJSON());
        if (attempts.length === 1) {
          verification = route;
          return;
        }
        return route.fulfill({
          json: { person, token: 'audit-client', expiresAt: '2027-01-01T00:00:00Z' },
        });
      });
      await page.goto(app.url);
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const address = page.getByRole('textbox', { name: t.signIn.email, exact: true });
      await enlargeText(address);
      await expectFits(button(t.signIn.sendCode));
      await expect(button(t.signIn.sendCode)).toBeDisabled();
      await expect(page.getByRole('group', { name: t.catalog.recent })).toHaveCount(0);
      await address.fill(email);
      await doubleTap(button(t.signIn.sendCode));
      const code = page.getByRole('textbox', { name: t.signIn.code, exact: true });
      await expectFits(code);
      expect(codeRequests).toEqual([{ email, locale }]);
      await expect(button(t.signIn.confirm)).toBeDisabled();
      await code.fill('515151');
      await doubleTap(button(t.signIn.confirm));
      await expect(button(t.signIn.resend)).toBeDisabled();
      await expect(button(t.signIn.otherEmail)).toBeDisabled();
      await expect.poll(() => attempts.length).toBe(1);
      await verification!.abort('internetdisconnected');
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await expect(code).toHaveValue('515151');
      await expectFits(page.getByRole('alert'));
      await doubleTap(button(t.retry));
      await expect(page.getByText(t.visits.emptyUpcoming, { exact: true })).toBeVisible();
      const body = { email, code: '515151', locale, clientType: 'mobile' };
      expect(attempts).toEqual([body, body]);
    });

    test('restored session, four empty tabs, retry and personal data download', async ({
      page,
    }) => {
      const t = DICTIONARIES[locale];
      const person = { id: 'audit-client', email, locale };
      const file = {
        exportedAt: '2026-11-26T12:40:00Z',
        person: { email, locale, createdAt: '2026-01-01T00:00:00Z' },
        salons: [],
      };
      await saveSession(page);
      await getEmptyAccount(page);
      await page.route('**/v1/client/me', (route) => route.fulfill({ json: person }));
      await page.route('**/v1/client/me', (route) => route.abort('internetdisconnected'), {
        times: 1,
      });
      await page.route('**/v1/client/export', (route) => route.fulfill({ json: file }));
      await page.route('**/v1/client/auth/logout', (route) => route.abort('internetdisconnected'));
      await page.route('**/v1/public/locations?*', (route) => route.abort('internetdisconnected'));
      await page.goto(app.url);
      const alert = page.getByRole('alert');
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      await expect(alert).toHaveText(t.error.network);
      await enlargeText(alert);
      await expectFits(alert);
      await button(t.retry).click();
      await expect(page.getByText(t.visits.emptyUpcoming, { exact: true })).toBeVisible();

      for (const [name, empty, endpoint] of [
        [t.visits.past, t.visits.emptyPast, '/appointments?scope=past'],
        [t.bonuses.tab, t.bonuses.empty, '/loyalty'],
        [t.favorites.tab, t.favorites.empty, '/favorites'],
        [t.visits.upcoming, t.visits.emptyUpcoming, '/appointments?scope=upcoming'],
      ] as const) {
        const path = '**/v1/client' + endpoint;
        let reads = 0;
        const read = (route: Route) => {
          reads++;
          return reads === 1
            ? route.abort('internetdisconnected')
            : route.fulfill({ json: emptyList });
        };
        await page.route(path, read);
        const tab = page.getByRole('tab', { name, exact: true });
        await doubleTap(tab);
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expectFits(tab);
        await expect(alert).toHaveText(t.error.network);
        await expect(page.getByText(empty, { exact: true })).toHaveCount(0);
        await button(t.visits.refresh).click();
        await expectFits(page.getByText(empty, { exact: true }));
        await expect(alert).toHaveCount(0);
        expect(reads).toBe(2);
        await page.unroute(path, read);
      }

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        button(t.visits.downloadData).click(),
      ]);
      expect(download.suggestedFilename()).toBe('my-data-2026-11-26.json');
      expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(file);
      const nextLocale = locale === 'ru' ? 'uk' : 'ru';
      const next = DICTIONARIES[nextLocale];
      const saves: unknown[] = [];
      await page.route('**/v1/client/me', (route) => {
        expect(route.request().method()).toBe('PATCH');
        saves.push(route.request().postDataJSON());
        return saves.length === 1
          ? route.abort('internetdisconnected')
          : route.fulfill({ json: { ...person, locale: nextLocale } });
      });
      await button(t.language).click();
      const choice = nextLocale === 'uk' ? 'UA · ' + LANGUAGE_NAMES.uk : LANGUAGE_NAMES.ru;
      await button(choice).click();
      await expect(alert).toHaveText(next.error.network);
      await button(next.retry).click();
      await expect(alert).toHaveCount(0);
      expect(saves).toEqual([{ locale: nextLocale }, { locale: nextLocale }]);
      await button(next.visits.signOut).click();
      await expect(
        page.getByRole('textbox', { name: next.signIn.email, exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('beauty.client.session'))).toBeNull();
    });

    test('loyalty history and booking retry, paused favourite removal', async ({ page }) => {
      const t = DICTIONARIES[locale];
      await saveSession(page);
      await getEmptyAccount(page);
      await page.route('**/v1/client/me', (route) =>
        route.fulfill({ json: { id: 'audit-client', email, locale } }),
      );
      await page.route('**/v1/client/loyalty', (route) =>
        route.fulfill({ json: { items: [loyalty] } }),
      );
      await page.route('**/v1/client/favorites', (route) =>
        route.fulfill({ json: { items: [favorite] } }),
      );
      await page.route('**/v1/public/locations?*', (route) =>
        route.fulfill({ json: { items: [], total: 0, openNowCount: 0 } }),
      );
      let salonReads = 0;
      let pending: Route | undefined;
      await page.route('**/v1/public/locations/audit-studio', (route) => {
        if (++salonReads === 1) return route.abort('internetdisconnected');
        pending = route;
      });
      let removals = 0;
      await page.route('**/v1/client/favorites/audit-studio', (route) => {
        expect(route.request().method()).toBe('DELETE');
        return ++removals === 1
          ? route.abort('internetdisconnected')
          : route.fulfill({ status: 204 });
      });
      await page.goto(app.url);
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const tab = (name: string) => page.getByRole('tab', { name, exact: true });
      await enlargeText(page.getByRole('heading', { name: t.visits.title, exact: true }));
      await tab(t.bonuses.tab).click();
      await button(t.bonuses.showHistory).click();
      const history = page.getByRole('list', { name: t.bonuses.history });
      await expect(history.getByRole('listitem')).toContainText('Strzyżenie');
      await expectFits(button(t.bonuses.hideHistory));
      await doubleTap(button(t.bonuses.book));
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      expect(salonReads).toBe(1);
      await button(t.retry).click();
      await expect(page.getByRole('progressbar', { name: t.book.title })).toBeVisible();
      await expect.poll(() => salonReads).toBe(2);
      await button(t.book.back).click();
      await expect(tab(t.bonuses.tab)).toHaveAttribute('aria-selected', 'true');
      await pending!.abort('internetdisconnected');
      await tab(t.favorites.tab).click();
      await expectFits(page.getByText(t.favorites.notBookable, { exact: true }));
      await expect(button(t.salon.book)).toHaveCount(0);
      const remove = button(t.favorites.remove + ': ' + favorite.name);
      await remove.click();
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await expect(page.getByRole('heading', { name: favorite.name })).toBeVisible();
      await remove.click();
      await expect(page.getByText(t.favorites.empty, { exact: true })).toBeVisible();
      expect(removals).toBe(2);
    });
  });
}
