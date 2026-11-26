import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const locationsPath = '**/v1/organizations/org/locations';
const salon = {
  id: 'salon',
  name: 'Studio Centrum',
  addressLine: 'Bema 91',
  city: 'Warszawa',
  postalCode: '01-233',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  defaultLocale: 'pl',
  slug: 'studio-centrum',
  version: 1,
  onlineBookingEnabled: false,
  phone: null,
  email: null,
  latitude: null,
  longitude: null,
  drinks: [],
  languages: [],
  minLeadMinutes: 0,
  bookingHorizonDays: 30,
  clientCancelDeadlineMinutes: 0,
  slotStepMinutes: 15,
};
const salonPath = locationsPath + '/salon';
const guardPath = salonPath + '/cancellation-guard';
const rules = {
  enabled: true,
  maxNoShows: 2,
  maxChanges: null,
  windowHours: 720,
  lateCancelMinutes: null,
  action: 'approval',
  version: 1,
};
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true });
const reply = (page: Page, path: string, json: unknown) =>
  page.route(path, (route) => route.fulfill({ json }));

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
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply(page, '**/v1/auth/refresh', { accessToken: 'test-session' });
  await reply(page, '**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'org', role: 'owner', name: 'Studio' }],
  });
  await reply(page, locationsPath, [salon]);
  await reply(page, salonPath, salon);
  await page.route(locationsPath + '/*/calendar?*', (route) => {
    const from = new URL(route.request().url()).searchParams.get('from');
    return route.fulfill({
      json: { from, to: from, location: salon, staff: [], appointments: [] },
    });
  });
});

const returnToCalendar = (page: Page) =>
  page.getByRole('tab', { name: pl.navigation.calendar, exact: true }).click();
const openDetails = async (page: Page) => {
  await openBusinessMenu(page, pl.navigation.settings);
  await button(page, pl.navigation.salonDetails).click();
};
const leaveSettings = async (page: Page) => {
  await button(page, '‹ ' + pl.navigation.settings).click();
  await button(page, pl.salon.back).click();
};

test('salon details restore only the edited fields after a failed save and a trip to the calendar', async ({
  page,
}) => {
  const other = { ...salon, id: 'other', name: 'Studio Rynek', city: 'Kielce' };
  await reply(page, locationsPath, [salon, other]);
  await reply(page, locationsPath + '/other', other);
  let current = salon;
  const writes: unknown[] = [];
  await page.route(salonPath, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current });
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) {
      current = { ...salon, addressLine: 'Bema 92', version: 2 };
      return route.abort('connectionreset');
    }
    current = { ...current, city: 'Łódź', version: 3 };
    return route.fulfill({ json: current });
  });

  await page.goto(app.url);
  await button(page, salon.name).click();
  await openDetails(page);
  const city = field(page, pl.salon.city);
  const unsaved = page.getByText(pl.navigation.unsaved, { exact: true });
  await city.fill('Łódź');
  await button(page, pl.salon.save).click();
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await leaveSettings(page);
  await returnToCalendar(page);
  await openDetails(page);
  await expect(city).toHaveValue('Łódź');
  await expect(field(page, pl.salon.address)).toHaveValue('Bema 92');
  await expect(unsaved).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await button(page, pl.salon.save).click();
  await expect(page.getByText(pl.salon.saved, { exact: true })).toBeVisible();
  expect(writes).toEqual([
    { city: 'Łódź', version: 1 },
    { city: 'Łódź', version: 2 },
  ]);
  await leaveSettings(page);
  await openDetails(page);
  await expect(city).toHaveValue('Łódź');
  await expect(unsaved).toHaveCount(0);

  await city.fill('Kraków');
  await button(page, pl.navigation.discard).click();
  await leaveSettings(page);
  await openDetails(page);
  await expect(city).toHaveValue('Łódź');
  await expect(unsaved).toHaveCount(0);

  await city.fill('Poznań');
  await leaveSettings(page);
  await openBusinessMenu(page, pl.changeSalon);
  await button(page, other.name).click();
  await openDetails(page);
  await expect(city).toHaveValue('Kielce');
  await expect(unsaved).toHaveCount(0);
});

test('guard rules keep edits on return and both save and cancel end the draft', async ({
  page,
}) => {
  let current = rules;
  await reply(page, guardPath + '/clients', { currency: 'PLN', items: [] });
  const writes: unknown[] = [];
  await page.route(guardPath, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current });
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) return route.abort('connectionreset');
    if (writes.length === 2) {
      current = { ...rules, action: 'phone_only', version: 2 };
      return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT' } } });
    }
    current = { ...current, maxNoShows: 7, version: 3 };
    return route.fulfill({ json: current });
  });
  await page.goto(app.url);
  await openBusinessMenu(page, pl.guard.open);
  const edit = button(page, pl.guard.rulesChange);
  const count = field(page, pl.guard.noShows);
  const save = button(page, pl.guard.rulesSave);
  await edit.click();
  await count.fill('7');
  await save.click();
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await button(page, pl.guard.back).click();
  await returnToCalendar(page);
  await openBusinessMenu(page, pl.guard.open);
  await expect(count).toHaveValue('7');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await save.click();
  await expect(page.getByRole('alert')).toHaveText(pl.guard.conflict);
  await expect(count).toHaveValue('7');
  await expect(page.getByRole('radio', { name: pl.guard.actions.phone_only })).toBeChecked();
  await save.click();
  await expect(page.getByText(pl.guard.rulesSaved)).toBeVisible();
  const first = { ...rules, maxNoShows: 7 };
  expect(writes).toEqual([first, first, { ...first, action: 'phone_only', version: 2 }]);
  await button(page, pl.guard.back).click();
  await openBusinessMenu(page, pl.guard.open);
  await edit.click();
  await expect(count).toHaveValue('7');
  await count.fill('9');
  await button(page, pl.guard.cancel).click();
  await button(page, pl.guard.back).click();
  await openBusinessMenu(page, pl.guard.open);
  await edit.click();
  await expect(count).toHaveValue('7');
  await expect(page.getByText(pl.navigation.unsaved)).toHaveCount(0);
});

test('release notes belong to the marked client and disappear after cancellation or release', async ({
  page,
}) => {
  await reply(page, guardPath, rules);
  const clients = ['Anna', 'Ewa'].map((name) => ({
    customerId: name.toLowerCase(),
    name,
    rule: 'approval',
    reasons: ['no_shows'],
    changes: 0,
    lateCancellations: 0,
    noShows: 2,
    noShowAmountGrosze: 0,
  }));
  await reply(page, guardPath + '/clients', { currency: 'PLN', items: clients });
  const notes: unknown[] = [];
  await page.route(guardPath + '/clients/anna/release', (route) => {
    notes.push(route.request().postDataJSON());
    if (notes.length === 1) return route.abort('connectionreset');
    return route.fulfill({ json: {} });
  });
  await page.goto(app.url);
  await openBusinessMenu(page, pl.guard.open);
  const release = (name: string) =>
    button(page, pl.guard.releaseOne.replace('{name}', name)).click();
  const note = field(page, pl.guard.note);
  await release('Anna');
  await note.fill('Rozmowa w salonie');
  await button(page, pl.guard.releaseYes).click();
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await button(page, pl.guard.back).click();
  await openBusinessMenu(page, pl.guard.open);
  await expect(note).toHaveValue('Rozmowa w salonie');
  await release('Ewa');
  await expect(note).toHaveValue('');
  await note.fill('Inna osoba');
  await button(page, pl.guard.no).click();
  await release('Ewa');
  await expect(note).toHaveValue('');
  await release('Anna');
  await expect(note).toHaveValue('Rozmowa w salonie');
  await button(page, pl.guard.releaseYes).click();
  await expect(page.getByText(pl.guard.released)).toBeVisible();
  expect(notes).toEqual([{ note: 'Rozmowa w salonie' }, { note: 'Rozmowa w salonie' }]);
  // A mark for the same customer can appear again after the salon releases it.
  await release('Anna');
  await expect(note).toHaveValue('');
});

test('new salon protects entered details and retries only the unfinished location', async ({
  page,
}) => {
  const companyNames: string[] = [];
  const newLocations: unknown[] = [];
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'owner' },
        organizations: companyNames.map((name) => ({ id: 'org', role: 'owner', name })),
      },
    }),
  );
  await page.route('**/v1/organizations', (route) => {
    companyNames.push(route.request().postDataJSON().name);
    return route.fulfill({ status: 201, json: { id: 'org' } });
  });
  await page.route(locationsPath, (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: newLocations.length === 2 ? [salon] : [] });
    }
    newLocations.push(route.request().postDataJSON());
    if (newLocations.length === 1) return route.abort('connectionreset');
    return route.fulfill({ status: 201, json: salon });
  });

  await page.goto(app.url);
  const create = button(page, pl.newSalon.create);
  const back = button(page, pl.salon.back);
  const company = field(page, pl.newSalon.orgName);
  await create.click();
  await company.fill('Do odrzucenia');
  await back.click();
  await button(page, pl.navigation.discard).click();
  await create.click();
  await expect(company).toHaveValue('');
  await company.fill('Studio');
  await field(page, pl.newSalon.locationName).fill(salon.name);
  await field(page, pl.salon.address).fill(salon.addressLine);
  await field(page, pl.salon.city).fill(salon.city);
  await field(page, pl.salon.postalCode).fill(salon.postalCode);
  await create.click();
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await back.click();
  await expect(page.getByText(pl.navigation.unsaved, { exact: true })).toBeVisible();
  await back.click();
  await expect(company).toHaveValue('Studio');
  await expect(company).not.toBeEditable();
  await expect(field(page, pl.salon.address)).toHaveValue(salon.addressLine);
  await expect(field(page, pl.salon.city)).toHaveValue(salon.city);
  await create.click();
  await expect(page.getByRole('tab', { name: pl.navigation.calendar })).toBeVisible();
  expect(companyNames).toEqual(['Studio']);
  const body = {
    name: salon.name,
    addressLine: salon.addressLine,
    city: salon.city,
    postalCode: salon.postalCode,
    timezone: salon.timezone,
    currency: salon.currency,
    defaultLocale: 'pl',
  };
  expect(newLocations).toEqual([body, body]);
});
