import { expect, test, type Route } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-business/src/i18n';
import { openBusinessMenu, serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const organization = { id: 'org', name: 'Studio', role: 'staff' };
const salon = {
  id: 'first',
  name: 'Centrum',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};
const locations = '**/v1/organizations/org/locations';
const tokens = { accessToken: 'test-access', refreshToken: 'test-refresh' };
let app: Awaited<ReturnType<typeof serveApp>>;

test.use({ viewport: { width: 320, height: 740 }, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', (route) => route.abort());
});

test('typing a contact, code and salon name sends only the submitted requests', async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === '/v1/auth/code') return route.fulfill({ json: { channel: 'email' } });
    if (path === '/v1/auth/code/verify') return route.fulfill({ json: tokens });
    if (path === '/v1/me')
      return route.fulfill({ json: { user: { id: 'user' }, organizations: [] } });
    return route.abort();
  });
  await page.goto(app.url);
  await page.getByLabel(t.signIn.contact).pressSequentially('cl@example.com');
  expect(calls).toEqual([]);
  await page.getByRole('button', { name: t.signIn.sendCode }).click();
  await page.getByLabel(t.signIn.code, { exact: true }).pressSequentially('123456');
  expect(calls).toEqual(['/v1/auth/code']);
  await page.getByRole('button', { name: t.signIn.confirm }).click();
  await page.getByRole('button', { name: t.salons.create }).click();
  await page.getByLabel(t.newSalon.orgName, { exact: true }).pressSequentially('Studio');
  await expect(page.getByLabel(t.newSalon.orgName, { exact: true })).toHaveValue('Studio');
  expect(calls).toEqual(['/v1/auth/code', '/v1/auth/code/verify', '/v1/me']);
});

test('returning to salons and profile reuses the list and the saved languages', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'test-refresh'),
  );
  await page.route('**/v1/auth/refresh', (route) => route.fulfill({ json: tokens }));
  await page.route('**/v1/me', (route) =>
    route.fulfill({ json: { user: { id: 'user' }, organizations: [organization] } }),
  );
  let lists = 0;
  await page.route(locations, (route) => {
    lists++;
    return route.fulfill({ json: [salon, { ...salon, id: 'other', name: 'Rynek' }] });
  });
  const staff = { id: 'member', userId: 'user', displayName: 'Kasia', languages: ['pl'] };
  const staffPath = locations + '/first/staff';
  let staffReads = 0;
  let delayRead = false;
  let late: Route | undefined;
  await page.route(staffPath, (route) => {
    staffReads++;
    if (delayRead) {
      delayRead = false;
      late = route;
      return;
    }
    return route.fulfill({ json: [staff] });
  });

  await page.goto(app.url);
  await page.getByRole('button', { name: salon.name }).click();
  await openBusinessMenu(page, t.changeSalon);
  await expect(page.getByRole('button', { name: 'Rynek' })).toBeVisible();
  expect(lists).toBe(1);
  await page.getByRole('button', { name: salon.name }).click();
  await page.getByRole('tab', { name: t.navigation.more }).click();
  const profile = page.getByRole('button', { name: t.profile.open });
  await expect(profile).toBeVisible();
  const dayReads = staffReads;
  const back = page.getByRole('button', { name: t.profile.back });
  delayRead = true;
  await profile.click();
  await expect.poll(() => !!late).toBe(true);
  await back.click();
  await profile.click();
  await expect(page.getByText(staff.displayName, { exact: true })).toBeVisible();
  const finished = page.waitForEvent('requestfinished', (request) => request === late!.request());
  await late!.fulfill({ json: [{ ...staff, displayName: 'Old profile' }] });
  await finished;
  await back.click();
  await profile.click();
  await expect(page.getByText(staff.displayName, { exact: true })).toBeVisible();
  const english = page.getByRole('checkbox', { name: 'English' });
  await english.click();

  let write: Route | undefined;
  await page.route(staffPath + '/member/languages', (route) => {
    write = route;
  });
  await page.getByRole('button', { name: t.profile.save }).click();
  await expect.poll(() => !!write).toBe(true);
  await back.click();
  await profile.click();
  await write!.fulfill({
    json: { ...staff, languages: write!.request().postDataJSON().languages },
  });
  await expect(english).toBeChecked();
  await back.click();
  await profile.click();
  await expect(page.getByText(staff.displayName, { exact: true })).toBeVisible();
  await expect(english).toBeChecked();
  expect(staffReads - dayReads).toBe(2);
  expect(lists).toBe(1);
});
