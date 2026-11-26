import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const organization = { id: 'created-company', name: 'Studio', role: 'owner' };
const locationBody = {
  name: organization.name,
  addressLine: 'Rynek 1',
  city: 'Warszawa',
  postalCode: '00-001',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  defaultLocale: 'pl',
};
const location = { id: 'first-salon', ...locationBody };
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({
  viewport: { width: 320, height: 844 },
  isMobile: true,
  locale: 'pl-PL',
  timezoneId: location.timezone,
});
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());

async function fillLocation(page: Page) {
  await field(page, pl.salon.address).fill(location.addressLine);
  await field(page, pl.salon.city).fill(location.city);
  await field(page, pl.salon.postalCode).fill(location.postalCode);
}

async function leavePartialSalon(page: Page) {
  const organizationPosts: unknown[] = [];
  const locationPosts: unknown[] = [];
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'first'));
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({ json: { accessToken: 'first' } }),
  );
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'first' },
        organizations: organizationPosts.length ? [organization] : [],
      },
    }),
  );
  await page.route('**/v1/organizations', (route) => {
    organizationPosts.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: organization });
  });
  await page.route('**/v1/organizations/created-company/locations', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: locationPosts.length >= 2 ? [location] : [] });
    }
    locationPosts.push(route.request().postDataJSON());
    if (locationPosts.length === 1) return route.abort('connectionreset');
    return route.fulfill({ status: 201, json: location });
  });

  await page.goto(app.url);
  await button(page, pl.salons.create).click();
  const heading = page.getByRole('heading', { name: pl.newSalon.title });
  const fontSize = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await field(page, pl.newSalon.orgName).fill(organization.name);
  await fillLocation(page);
  await button(page, pl.newSalon.create).click();
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await button(page, pl.salon.back).click();
  await button(page, pl.navigation.discard).click();
  await expect(page.getByText(pl.salons.ownTitle, { exact: true })).toBeVisible();
  return { organizationPosts, locationPosts };
}

test('discarding the first location keeps the created organization for the next attempt', async ({
  page,
}) => {
  const { organizationPosts, locationPosts } = await leavePartialSalon(page);
  await button(page, pl.salons.create).click();
  const company = field(page, pl.newSalon.orgName);
  await expect(company).toHaveValue(organization.name);
  await expect(company).not.toBeEditable();
  await expect(field(page, pl.salon.address)).toHaveValue('');
  await fillLocation(page);
  await button(page, pl.newSalon.create).click();
  await expect(page.getByRole('tab', { name: pl.navigation.calendar })).toBeVisible();
  expect(organizationPosts).toEqual([{ name: organization.name }]);
  expect(locationPosts).toEqual([locationBody, locationBody]);
});

test('signing in to a different account starts a fresh organization', async ({ page }) => {
  await leavePartialSalon(page);
  await page.route('**/v1/auth/logout', (route) => route.fulfill({ status: 204 }));
  await button(page, pl.signOut).click();
  await page.route('**/v1/auth/code', (route) => route.fulfill({ json: { channel: 'email' } }));
  await page.route('**/v1/auth/code/verify', (route) =>
    route.fulfill({ json: { accessToken: 'second', refreshToken: 'second' } }),
  );
  await page.route('**/v1/me', (route) =>
    route.fulfill({ json: { user: { id: 'second' }, organizations: [] } }),
  );
  await field(page, pl.signIn.contact).fill('second@example.com');
  await button(page, pl.signIn.sendCode).click();
  await field(page, pl.signIn.code).fill('012345');
  await button(page, pl.signIn.confirm).click();
  await button(page, pl.salons.create).click();
  const company = field(page, pl.newSalon.orgName);
  await expect(company).toBeEditable();
  await expect(company).toHaveValue('');
});
