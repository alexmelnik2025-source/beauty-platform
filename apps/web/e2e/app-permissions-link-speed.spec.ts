import { expect, test, type Page, type Request } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const org = '**/v1/organizations/cs';
const location = org + '/locations/salon';
const salon = {
  id: 'salon',
  name: 'Salon CS',
  city: 'Warszawa',
  slug: 'salon-cs',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  defaultLocale: 'pl',
  onlineBookingEnabled: true,
};
const kasia = { id: 'kasia', active: true, displayName: 'Kasia' };
const member = {
  membershipId: 'staff',
  role: 'staff',
  status: 'active',
  locationIds: ['salon'],
  user: { id: 'kasia', name: 'Kasia' },
  version: 1,
  staffCategoryId: null,
  overrides: {},
};
const catalog = Object.keys(pl.rights.names).map((key) => ({ key, default: false }));
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());

async function openApp(page: Page) {
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'session'));
  const calls: string[] = [];
  async function reply(path: string, json: unknown) {
    await page.route(path, (route) => {
      calls.push(route.request().method() + ' ' + path);
      return route.fulfill({ json });
    });
  }
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply('**/v1/auth/refresh', { accessToken: 'session' });
  await reply('**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'cs', role: 'owner', name: 'CS' }],
  });
  await reply(org + '/locations', [salon]);
  await reply(location, salon);
  await reply(location + '/staff', [{ ...kasia, userId: 'kasia' }]);
  await reply(org + '/members', [member]);
  await reply(org + '/invitations', []);
  await reply(org + '/permissions', {
    permissions: catalog,
    me: { role: 'owner', permissions: {} },
  });
  await reply(org + '/staff-categories', []);
  await page.route(location + '/calendar?*', (route) => {
    const from = new URL(route.request().url()).searchParams.get('from');
    return route.fulfill({
      json: { from, to: from, location: salon, staff: [], appointments: [] },
    });
  });
  await page.goto(app.url);
  await expect(page.getByRole('tab', { name: pl.navigation.more })).toBeVisible();
  return calls;
}

test('reopening permissions reuses the lists and saving an exception needs one request', async ({
  page,
}) => {
  const calls = await openApp(page);
  await openBusinessMenu(page, pl.team.open);
  await expect(page.getByText('Kasia', { exact: true }).first()).toBeVisible();
  calls.length = 0;
  await button(page, pl.rights.open).click();
  const edit = button(page, pl.rights.change + ': Kasia');
  await expect(edit).toBeVisible();
  expect([...calls].sort()).toEqual(
    ['/members', '/permissions', '/staff-categories'].map((path) => 'GET ' + org + path),
  );
  await edit.click();
  const allow = page.getByRole('radio', {
    name: pl.rights.names.viewClientContacts + ': ' + pl.rights.allow,
    exact: true,
  });
  calls.length = 0;
  await allow.click();
  await expect(allow).toBeChecked();
  expect(calls).toEqual([]);
  const path = org + '/members/staff/permissions';
  await page.route(path, (route) => {
    calls.push(route.request().method() + ' ' + path);
    const overrides = { viewClientContacts: true };
    expect(route.request().postDataJSON()).toEqual({
      version: 1,
      staffCategoryId: null,
      overrides,
    });
    return route.fulfill({ json: { ...member, overrides, version: 2 } });
  });
  await button(page, pl.rights.save).click();
  await expect(edit).toBeVisible();
  expect(calls).toEqual(['PUT ' + path]);

  await button(page, pl.rights.back).click();
  // The team overview has its own load on return. Count only the next permissions visit.
  await expect
    .poll(
      () =>
        calls.filter((call) =>
          [org + '/members', org + '/invitations', location + '/staff'].some(
            (path) => call === 'GET ' + path,
          ),
        ).length,
    )
    .toBe(3);
  calls.length = 0;
  await button(page, pl.rights.open).click();
  await edit.click();
  await expect(allow).toBeChecked();
  expect(calls).toEqual([]);
});

test('salon and specialist links reuse loaded data across sharing and a return visit', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: undefined }));
  const calls = await openApp(page);
  const openLinks = () => openBusinessMenu(page, pl.bookingLink.open);
  const reads = () =>
    calls.filter((call) => [location, location + '/staff'].some((path) => call === 'GET ' + path));
  await openLinks();
  const link = page.getByText(/\/pl\/b\/salon-cs$/);
  const qr = page.getByRole('img', { name: pl.bookingLink.qrAlt, exact: true });
  await expect(link).toBeVisible();
  await expect(qr).toBeVisible();
  const specialist = button(page, 'Kasia');
  await expect(specialist).toBeVisible();
  calls.length = 0;
  await specialist.click();
  const staffQr = page.getByTestId('staff-qr');
  await expect(staffQr).toBeVisible();
  // A copy confirmation should preserve the already drawn modules of both codes.
  const modules = await Promise.all(
    [qr, staffQr].map((image) => image.locator(':scope > *').first().elementHandle()),
  );
  await button(page, pl.bookingLink.share + ': Salon CS').click();
  await expect(page.getByText(pl.bookingLink.copied)).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.innerText());
  await button(page, pl.bookingLink.staffQrShare).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/\/s\/salon-cs\?utm_source=qr&staff=kasia$/);
  for (const module of modules)
    expect(await module.evaluate((node) => node.isConnected)).toBe(true);
  expect(reads()).toEqual([]);
  await button(page, pl.bookingLink.back).click();
  await expect(page.getByRole('tab', { name: pl.navigation.more })).toBeVisible();
  calls.length = 0;
  await openLinks();
  await expect(specialist).toBeVisible();
  await expect(qr).toBeVisible();
  expect(reads()).toEqual([]);
});

test('a delayed read from the previous permissions visit cannot replace the newer list', async ({
  page,
}) => {
  await openApp(page);
  await openBusinessMenu(page, pl.team.open);
  await expect(page.getByText('Kasia', { exact: true }).first()).toBeVisible();
  const category = { id: 'senior', version: 1, memberCount: 0, permissions: {} };
  const path = org + '/staff-categories';
  let reads = 0;
  let previous: Request | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path, async (route) => {
    const first = ++reads === 1;
    if (first) {
      previous = route.request();
      await held;
    }
    await route.fulfill({ json: [{ ...category, name: first ? 'Previous' : 'Current' }] });
  });

  await button(page, pl.rights.open).click();
  try {
    await expect.poll(() => reads).toBe(1);
    await button(page, pl.rights.back).click();
    await button(page, pl.rights.open).click();
    await expect(button(page, pl.rights.change + ': Current')).toBeVisible();
  } finally {
    const finished = page.waitForEvent('requestfinished', (request) => request === previous);
    release();
    await finished;
  }
  await button(page, pl.rights.back).click();
  await button(page, pl.rights.open).click();
  await expect(button(page, pl.rights.change + ': Current')).toBeVisible();
  await expect(button(page, pl.rights.change + ': Previous')).toHaveCount(0);
  expect(reads).toBe(2);
});

test('saving a category flag keeps the confirmed version and does not reread the lists', async ({
  page,
}) => {
  const calls = await openApp(page);
  const category = { id: 'senior', name: 'Senior', version: 1, memberCount: 0, permissions: {} };
  const path = org + '/staff-categories';
  await page.route(path, (route) => {
    calls.push('GET ' + path);
    return route.fulfill({ json: [category] });
  });
  await openBusinessMenu(page, pl.team.open);
  await button(page, pl.rights.open).click();
  const edit = button(page, pl.rights.change + ': Senior');
  await edit.click();
  const contacts = page.getByRole('checkbox', { name: pl.rights.names.viewClientContacts });
  const other = page.getByRole('checkbox', { name: pl.rights.names.viewClientNotes });
  calls.length = 0;
  let version = 1;
  await page.route(path + '/senior', (route) => {
    calls.push(route.request().method());
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({
      version,
      name: 'Senior',
      permissions: { viewClientContacts: version === 1, viewClientNotes: false },
    });
    return route.fulfill({
      json: { ...category, permissions: body.permissions, version: ++version },
    });
  });
  for (const checked of [true, false]) {
    await contacts.click();
    await expect(contacts).toBeChecked({ checked });
    await expect(other).not.toBeChecked();
    await button(page, pl.rights.save).click();
    await edit.click();
    await expect(contacts).toBeChecked({ checked });
  }
  expect(calls).toEqual(['PATCH', 'PATCH']);
});
