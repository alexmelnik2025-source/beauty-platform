import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const path = '**/v1/organizations/org/locations/salon';
const salon = {
  id: 'salon',
  name: 'Studio CP',
  city: 'Warszawa',
  addressLine: 'Bema 91',
  postalCode: '01-233',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  defaultLocale: 'pl',
  slug: 'studio-cp',
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

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 700 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'test-session'),
  );
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  const reply = (url: string, json: unknown) => page.route(url, (route) => route.fulfill({ json }));
  await reply('**/v1/auth/refresh', { accessToken: 'test-session' });
  await reply('**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'org', role: 'owner', name: 'CP' }],
  });
  await reply('**/v1/organizations/org/locations', [salon]);
  await page.route(path + '/calendar?*', (route) => {
    const from = new URL(route.request().url()).searchParams.get('from');
    return route.fulfill({
      json: { from, to: from, location: salon, staff: [], appointments: [] },
    });
  });
});

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const sections = (page: Page) => button(page, '‹ ' + pl.navigation.settings).click();
const settings = (page: Page) => openBusinessMenu(page, pl.navigation.settings);

test('reopening settings reuses salon data and photos; saving writes the edited field once', async ({
  page,
}) => {
  let reads = 0;
  let photos = 0;
  const patches: unknown[] = [];
  await page.route(path, (route) => {
    if (route.request().method() === 'GET') {
      reads++;
      return route.fulfill({ json: salon });
    }
    expect(route.request().method()).toBe('PATCH');
    patches.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...salon, city: 'Warszawa Centrum', version: 2 } });
  });
  await page.route(path + '/photos', (route) => {
    photos++;
    return route.fulfill({ json: [] });
  });
  await page.goto(app.url);
  // The day dashboard also reads this endpoint. Start the count in the More menu.
  await page.getByRole('tab', { name: pl.navigation.more, exact: true }).click();
  await expect(button(page, pl.navigation.settings)).toBeVisible();
  reads = 0;
  await settings(page);
  const openPhotos = async () => {
    await button(page, pl.salon.photos).click();
    await expect(page.getByText(pl.salon.photosNone)).toBeVisible();
    await sections(page);
  };
  await openPhotos();
  const openDetails = () => button(page, pl.navigation.salonDetails).click();
  const city = page.getByRole('textbox', { name: pl.salon.city, exact: true });
  await openDetails();
  await city.press('End');
  await city.pressSequentially(' Centrum');
  await expect(city).toHaveValue('Warszawa Centrum');
  await sections(page);
  await openDetails();
  await expect(city).toHaveValue('Warszawa Centrum');
  await button(page, pl.salon.save).click();
  await expect(page.getByText(pl.salon.saved, { exact: true })).toBeVisible();
  await sections(page);
  await openPhotos();
  await button(page, pl.salon.back).click();
  await settings(page);
  await openPhotos();
  await openDetails();
  await expect(city).toHaveValue('Warszawa Centrum');
  expect({ reads, photos, patches }).toEqual({
    reads: 1,
    photos: 1,
    patches: [{ city: 'Warszawa Centrum', version: 1 }],
  });
});

test('a late photo response from a closed section cannot replace the next visit', async ({
  page,
}) => {
  await page.route(path, (route) => route.fulfill({ json: salon }));
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path + '/photos', async (route) => {
    if (++reads === 1) {
      await held;
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: [{ id: 'new', url: '/new-photo.png' }] });
  });
  try {
    await page.goto(app.url);
    await settings(page);
    await button(page, pl.salon.photos).click();
    await expect.poll(() => reads).toBe(1);
    await sections(page);
    await button(page, pl.salon.photos).click();
    const photo = button(page, pl.salon.photoRemove + ': ' + pl.salon.photo.replace('{n}', '1'));
    await expect(photo).toBeVisible();
    const firstFinished = page.waitForEvent('requestfinished', (request) =>
      request.url().endsWith('/photos'),
    );
    release();
    await firstFinished;
    await sections(page);
    await button(page, pl.salon.photos).click();
    await expect(photo).toBeVisible();
    expect(reads).toBe(2);
  } finally {
    release();
  }
});

test('leaving before salon data arrives starts a fresh read on return', async ({ page }) => {
  await page.route(path, (route) => route.fulfill({ json: salon }));
  await page.goto(app.url);
  await page.getByRole('tab', { name: pl.navigation.more, exact: true }).click();
  const open = button(page, pl.navigation.settings);
  await expect(open).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route(path, async (route) => {
    if (++reads === 1) {
      await held;
      return route.fulfill({ json: salon });
    }
    return route.fulfill({ json: { ...salon, city: 'Łódź', version: 2 } });
  });
  try {
    await open.click();
    await expect.poll(() => reads).toBe(1);
    await button(page, pl.salon.back).click();
    await open.click();
    await button(page, pl.navigation.salonDetails).click();
    const city = page.getByRole('textbox', { name: pl.salon.city, exact: true });
    await expect(city).toHaveValue('Łódź');
    const firstFinished = page.waitForEvent('requestfinished', (request) =>
      request.url().endsWith('/locations/salon'),
    );
    release();
    await firstFinished;
    await sections(page);
    await button(page, pl.salon.back).click();
    await open.click();
    await button(page, pl.navigation.salonDetails).click();
    await expect(city).toHaveValue('Łódź');
    expect(reads).toBe(2);
  } finally {
    release();
  }
});

test('edits made during a save survive the response and discard restores the saved form', async ({
  page,
}) => {
  const writes: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: salon });
    writes.push(route.request().postDataJSON());
    await held;
    return route.fulfill({ json: { ...salon, city: 'Łódź', version: 2 } });
  });
  try {
    await page.goto(app.url);
    await settings(page);
    await button(page, pl.navigation.salonDetails).click();
    const city = page.getByRole('textbox', { name: pl.salon.city, exact: true });
    const description = page.getByRole('textbox', { name: pl.salon.description, exact: true });
    await city.fill(' Łódź ');
    await button(page, pl.salon.save).click();
    await expect.poll(() => writes).toEqual([{ city: 'Łódź', version: 1 }]);
    await description.fill('Studio');
    release();
    await expect(page.getByText(pl.salon.saved, { exact: true })).toBeVisible();
    await expect(city).toHaveValue('Łódź');
    await expect(description).toHaveValue('Studio');
    await button(page, pl.navigation.discard).click();
    await expect(description).toHaveValue('');
    await expect(city).toHaveValue('Łódź');
    await expect(button(page, pl.salon.save)).toHaveCount(0);
    expect(writes).toHaveLength(1);
  } finally {
    release();
  }
});
