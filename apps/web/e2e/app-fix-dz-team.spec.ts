import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const org = '**/v1/organizations/org';
const location = org + '/locations/salon';
const salon = {
  id: 'salon',
  name: 'Salon DZ',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const reply = (page: Page, path: string, json: unknown) =>
  page.route(path, (route) => route.fulfill({ json }));
const staff = [
  { id: 'a', displayName: 'Anna', active: true, sortOrder: 0 },
  { id: 'b', displayName: 'Basia', active: true, sortOrder: 1 },
  { id: 'c', displayName: 'Celina', active: false, sortOrder: 2 },
  { id: 'd', displayName: 'Daria', active: false, sortOrder: 3 },
];

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 740 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'dz-team'));
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply(page, '**/v1/auth/refresh', { accessToken: 'access', refreshToken: 'dz-team' });
  await reply(page, '**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'org', name: salon.name, role: 'owner' }],
  });
  await reply(page, org + '/locations', [salon]);
  await reply(page, location + '/staff', staff);
  await page.goto(app.url);
  await page.getByRole('tab', { name: pl.navigation.more, exact: true }).click();
  const label = button(page, pl.team.open).getByText(pl.team.open, { exact: true });
  const fontSize = () => label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const originalSize = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(originalSize * 1.3, 1);
});

test('team reloads its roster in place when the first membership read fails', async ({ page }) => {
  await reply(page, org + '/invitations', []);
  let memberReads = 0;
  await page.route(org + '/members', (route) => {
    if (++memberReads === 1) return route.abort('internetdisconnected');
    return route.fulfill({ json: [] });
  });
  await button(page, pl.team.open).click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(pl.error.network);
  await button(page, pl.day.refresh).click();
  await expect(button(page, pl.team.invite + ': Anna')).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(button(page, pl.day.refresh)).toHaveCount(0);
  expect(memberReads).toBe(2);
});

test('team hours retries a disconnected staff read and moves specialists within their active group', async ({
  page,
}) => {
  let reads = 0;
  await page.route(location + '/staff', (route) => {
    if (++reads === 1) return route.abort('internetdisconnected');
    return route.fulfill({ json: staff });
  });
  const orders: string[][] = [];
  await page.route(location + '/staff/order', (route) => {
    expect(route.request().method()).toBe('PUT');
    const { staffIds } = route.request().postDataJSON() as { staffIds: string[] };
    orders.push(staffIds);
    return route.fulfill({
      json: staff.map((person) => ({ ...person, sortOrder: staffIds.indexOf(person.id) })),
    });
  });
  await button(page, pl.schedule.teamOpen).click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(pl.error.network);
  await button(page, pl.day.refresh).click();
  await expect(button(page, 'Anna')).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(reads).toBe(2);

  const down = (name: string) => button(page, pl.staffProfile.down.replace('{name}', name));
  const up = (name: string) => button(page, pl.staffProfile.up.replace('{name}', name));
  const profiles = page.getByRole('button', { name: /^(Anna|Basia|Celina|Daria)$/ });
  await expect(down('Basia')).toBeDisabled();
  await expect(up('Celina')).toBeDisabled();
  await down('Anna').click();
  await expect(profiles.nth(0)).toHaveAccessibleName('Basia');
  await expect(up('Basia')).toBeDisabled();
  await expect(down('Anna')).toBeDisabled();
  await up('Daria').click();
  await expect(profiles.nth(2)).toHaveAccessibleName('Daria');
  await expect(up('Daria')).toBeDisabled();
  await expect(down('Celina')).toBeDisabled();
  expect(orders).toEqual([
    ['b', 'a', 'c', 'd'],
    ['b', 'a', 'd', 'c'],
  ]);
});
