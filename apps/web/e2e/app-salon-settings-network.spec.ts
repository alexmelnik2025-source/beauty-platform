import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const org = '**/v1/organizations/org';
const location = org + '/locations/salon';
const salon = {
  id: 'salon',
  name: 'Salon CD',
  city: 'Warszawa',
  addressLine: 'Bema 91',
  postalCode: '01-233',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  defaultLocale: 'pl',
  slug: 'salon-cd',
  version: 1,
  onlineBookingEnabled: false,
  email: null,
  phone: null,
  latitude: null,
  longitude: null,
  drinks: [],
  languages: [],
  minLeadMinutes: 0,
  bookingHorizonDays: 30,
  clientCancelDeadlineMinutes: 0,
  slotStepMinutes: 15,
};
const member = {
  membershipId: 'member',
  role: 'staff',
  status: 'active',
  locationIds: ['salon'],
  user: { id: 'kasia', name: 'Kasia' },
  version: 1,
  staffCategoryId: null,
  overrides: {},
};
const team = [{ id: 'specialist', userId: 'kasia', active: true, displayName: 'Kasia' }];
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'test-session'),
  );
  const reply = (path: string, json: unknown) =>
    page.route(path, (route) => route.fulfill({ json }));
  // Dashboard widgets outside these screens must not reach a real backend.
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply('**/v1/auth/refresh', { accessToken: 'test-session' });
  await reply('**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'org', role: 'owner', name: 'CD' }],
  });
  await reply(org + '/locations', [salon]);
  await reply(location, salon);
  await reply(location + '/staff', team);
  await reply(org + '/members', [member]);
  await reply(org + '/invitations', []);
  await reply(org + '/staff-categories', []);
  await reply(org + '/permissions', {
    permissions: [{ key: 'viewClientContacts', default: false }],
    me: { role: 'owner', permissions: {} },
  });
  await page.route(location + '/calendar?*', (route) => {
    const from = new URL(route.request().url()).searchParams.get('from');
    return route.fulfill({
      json: { from, to: from, location: salon, staff: [], appointments: [] },
    });
  });
  await page.goto(app.url);
  await expect(page.getByRole('tab', { name: pl.navigation.more })).toBeVisible();
});

// Hold the first write until both taps have happened, then simulate losing the connection.
async function interruptSave(page: Page, path: string, save: Locator) {
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    if (route.request().method() === 'GET') return route.fallback();
    writes++;
    await held;
    await route.abort('connectionreset');
  };
  await page.route(path, handler);
  try {
    await save.dblclick();
    await expect(save).toBeDisabled();
    await expect.poll(() => writes).toBe(1);
    await expect(page.getByText(pl.navigation.unsaved, { exact: true })).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await expect(save).toBeEnabled();
  await expect(page.getByText(pl.navigation.unsaved, { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await page.unroute(path, handler);
}

function rejectField(route: Route, path: string) {
  return route.fulfill({
    status: 400,
    json: { error: { code: 'VALIDATION_ERROR', details: [{ path, message: 'Invalid value' }] } },
  });
}

test('salon keeps the draft and attaches the server error to the field', async ({ page }) => {
  await openBusinessMenu(page, pl.navigation.settings);
  await page.getByRole('button', { name: /^Dane salonu/ }).click();
  const city = page.getByLabel(pl.salon.city, { exact: true });
  const save = button(page, pl.salon.save);
  await city.fill('Kraków');
  await interruptSave(page, location, save);
  await expect(city).toHaveValue('Kraków');
  await page.route(location, (route) => rejectField(route, 'city'), { times: 1 });
  await save.click();
  await expect(city).toHaveAccessibleDescription('! ' + pl.salon.badCity);
  await city.fill('Łódź');
  await page.route(location, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ city: 'Łódź', version: 1 });
    return route.fulfill({ json: { ...salon, city: 'Łódź', version: 2 } });
  });
  await save.click();
  await expect(page.getByText(pl.salon.saved)).toBeVisible();
  await expect(page.getByText(pl.navigation.unsaved)).toHaveCount(0);
});

test('guard rules can be retried with the same values', async ({ page }) => {
  const path = location + '/cancellation-guard';
  const rules = {
    enabled: false,
    windowHours: 720,
    maxChanges: null,
    lateCancelMinutes: null,
    maxNoShows: null,
    action: 'approval',
    version: 1,
  };
  await page.route(path, (route) => route.fulfill({ json: rules }));
  await page.route(path + '/clients', (route) =>
    route.fulfill({ json: { currency: 'PLN', items: [] } }),
  );
  await openBusinessMenu(page, pl.guard.open);
  await button(page, pl.guard.rulesChange).click();
  const toggle = page.getByRole('checkbox', { name: pl.guard.noShowsOn });
  await toggle.click();
  const count = page.getByLabel(pl.guard.noShows, { exact: true });
  await count.fill('3');
  const save = button(page, pl.guard.rulesSave);
  await interruptSave(page, path, save);
  await expect(toggle).toBeChecked();
  await expect(count).toHaveValue('3');
  await page.route(path, (route) => rejectField(route, 'maxNoShows'), { times: 1 });
  await save.click();
  await expect(count).toHaveAccessibleDescription('! ' + pl.guard.problem.noShows);
  await count.fill('4');
  await page.route(path, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ maxNoShows: 4, version: 1 });
    return route.fulfill({ json: { ...rules, maxNoShows: 4, version: 2 } });
  });
  await save.click();
  await expect(page.getByText(pl.guard.rulesSaved)).toBeVisible();
  await expect(page.getByText(pl.navigation.unsaved)).toHaveCount(0);
});

test('member permissions keep the selected exception after a failed save', async ({ page }) => {
  await openBusinessMenu(page, pl.team.open);
  await button(page, pl.rights.open).click();
  await button(page, pl.rights.change + ': Kasia').click();
  const allow = page.getByRole('radio', {
    name: pl.rights.names.viewClientContacts + ': ' + pl.rights.allow,
    exact: true,
  });
  await allow.click();
  const save = button(page, pl.rights.save);
  const path = org + '/members/member/permissions';
  await interruptSave(page, path, save);
  await expect(allow).toBeChecked();
  const saved = { ...member, overrides: { viewClientContacts: true }, version: 2 };
  await page.route(path, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      version: 1,
      overrides: saved.overrides,
    });
    return route.fulfill({ json: saved });
  });
  await page.route(org + '/members', (route) => route.fulfill({ json: [saved] }));
  await save.click();
  await expect(page.getByText(pl.rights.saved)).toBeVisible();
  await expect(save).toHaveCount(0);
  await button(page, pl.rights.change + ': Kasia').click();
  await expect(allow).toBeChecked();
});

test('a category keeps its name and permissions until the server accepts it', async ({ page }) => {
  await openBusinessMenu(page, pl.team.open);
  await button(page, pl.rights.open).click();
  await button(page, pl.rights.addCategory).click();
  const name = page.getByLabel(pl.rights.categoryName, { exact: true });
  const contacts = page.getByRole('checkbox', { name: pl.rights.names.viewClientContacts });
  await name.fill('Senior');
  await contacts.click();
  const path = org + '/staff-categories';
  const save = button(page, pl.rights.save);
  await interruptSave(page, path, save);
  await expect(name).toHaveValue('Senior');
  await expect(contacts).toBeChecked();
  await page.route(
    path,
    (route) => route.fulfill({ status: 409, json: { error: { code: 'CATEGORY_NAME_TAKEN' } } }),
    { times: 1 },
  );
  await save.click();
  await expect(name).toHaveAccessibleDescription('! ' + pl.error.generic);
  await name.fill('Senior II');
  const category = {
    id: 'senior',
    name: 'Senior II',
    permissions: { viewClientContacts: true },
    version: 1,
    memberCount: 0,
  };
  await page.route(path, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [category] });
    expect(route.request().postDataJSON()).toEqual({
      name: category.name,
      permissions: category.permissions,
    });
    return route.fulfill({ status: 201, json: category });
  });
  await save.click();
  await expect(page.getByText(pl.rights.categorySaved)).toBeVisible();
  await expect(page.getByText(category.name, { exact: true })).toBeVisible();
});

test('booking link and specialist QR recover after separate read failures', async ({ page }) => {
  const offline = (route: Route) => route.abort('connectionreset');
  await page.route(location, offline);
  await page.route(location + '/staff', offline);
  await openBusinessMenu(page, pl.bookingLink.open);
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(pl.error.network);
  const refresh = button(page, pl.day.refresh);
  await page.unroute(location, offline);
  await refresh.click();
  await expect(page.getByText(/\/pl\/b\/salon-cd$/)).toBeVisible();
  await expect(alert).toHaveText(pl.error.network);
  await page.unroute(location + '/staff', offline);
  await refresh.click();
  await button(page, 'Kasia').click();
  await expect(page.getByRole('img', { name: 'Kod QR rezerwacji u Kasia' })).toBeVisible();
  await expect(alert).toHaveCount(0);
});
