import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const org = '**/v1/organizations/org';
const location = org + '/locations/salon';
const loyalty = org + '/loyalty';
const l = pl.loyalty;
const salon = {
  id: 'salon',
  name: 'Salon DZ',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};
const reply = (page: Page, path: string, json: unknown) =>
  page.route(path, (route) => route.fulfill({ json }));
const sections = [
  { path: '/tiers', empty: l.tiersNone, data: { basis: 'visits', periodDays: 90, tiers: [] } },
  { path: '/bonus-rules', empty: l.bonusNone, data: { rules: [] } },
];

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 740 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

for (const section of sections) {
  test(`loyalty retries its catalog and then only the failed ${section.path} section`, async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'dz'));
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
    await reply(page, '**/v1/auth/refresh', { accessToken: 'access', refreshToken: 'dz' });
    await reply(page, '**/v1/me', {
      user: { id: 'owner' },
      organizations: [{ id: 'org', name: salon.name, role: 'owner' }],
    });
    await reply(page, org + '/locations', [salon]);
    await reply(page, location + '/services', []);
    await reply(page, location + '/staff', []);
    await reply(page, loyalty + '/program', {
      enabled: true,
      mode: 'stamps',
      stampsPerVisit: 1,
      minSpendGrosze: 0,
      maxDiscountPercent: 100,
      earnRules: [],
    });
    await reply(page, loyalty + '/transactions?*', []);

    let catalogReads = 0;
    await page.route(loyalty + '/rewards', (route) =>
      ++catalogReads === 1 ? route.abort('internetdisconnected') : route.fulfill({ json: [] }),
    );
    let sectionReads = 0;
    for (const current of sections) {
      await page.route(loyalty + current.path, (route) =>
        current === section && ++sectionReads === 1
          ? route.abort('internetdisconnected')
          : route.fulfill({ json: current.data }),
      );
    }

    await page.goto(app.url);
    await openBusinessMenu(page, l.open);
    const alert = page.getByRole('alert');
    const refresh = page.getByRole('button', { name: pl.day.refresh, exact: true });
    await expect(alert).toHaveText(pl.error.network);
    const fontSize = () => alert.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const normal = await fontSize();
    await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
    expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
    await expect(page.getByText(l.on, { exact: true })).toHaveCount(0);

    await refresh.evaluate((element: HTMLElement) => {
      element.click();
      element.click();
    });
    await expect(page.getByText(l.on, { exact: true })).toBeVisible();
    await expect(alert).toHaveText(pl.error.network);
    await expect(page.getByText(section.empty, { exact: true })).toHaveCount(0);
    await refresh.click();

    for (const current of sections) {
      await expect(page.getByText(current.empty, { exact: true })).toBeVisible();
    }
    await expect(alert).toHaveCount(0);
    await expect(refresh).toHaveCount(0);
    expect(catalogReads).toBe(2);
    expect(sectionReads).toBe(2);
  });
}
