import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const org = '**/v1/organizations/org';
const location = org + '/locations/salon';
const salon = {
  id: 'salon',
  name: 'Salon DK',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const reply = (page: Page, path: string, json: unknown) =>
  page.route(path, (route) => route.fulfill({ json }));

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'dk-session'),
  );
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply(page, '**/v1/auth/refresh', { accessToken: 'dk-access', refreshToken: 'dk-session' });
  await reply(page, '**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'org', name: salon.name, role: 'owner' }],
  });
  await reply(page, org + '/locations', [salon]);
  await reply(page, location + '/services', []);
});

test('a reward keeps its edited cost on return and saves the current catalog name', async ({
  page,
}) => {
  const l = pl.loyalty;
  const loyalty = org + '/loyalty';
  await reply(page, loyalty + '/program', {
    enabled: true,
    mode: 'stamps',
    stampsPerVisit: 1,
    pointsPerUnit: 1,
    spendUnitGrosze: 100,
    minSpendGrosze: 0,
    pointsValidityDays: null,
    maxDiscountPercent: 100,
    allowStacking: false,
    marketplaceEnabled: false,
    earnRules: [],
    version: 1,
  });
  await reply(page, loyalty + '/transactions?*', []);
  await reply(page, loyalty + '/tiers', { basis: 'visits', periodDays: 365, tiers: [] });
  await reply(page, loyalty + '/bonus-rules', { rules: [] });
  await reply(page, location + '/staff', []);
  let reward = {
    id: 'gift',
    name: 'Rabat',
    kind: 'discount_percent',
    discountPercent: 20,
    freeServiceId: null,
    cost: 4,
    serviceIds: [],
    couponValidityDays: null,
    sortOrder: 0,
    archivedAt: null,
    version: 1,
  };
  await page.route(loyalty + '/rewards', (route) => route.fulfill({ json: [reward] }));
  const updates: unknown[] = [];
  await page.route(loyalty + '/rewards/gift', (route) => {
    expect(route.request().method()).toBe('PUT');
    const update = route.request().postDataJSON();
    updates.push(update);
    reward = { ...reward, ...update, version: reward.version + 1 };
    return route.fulfill({ json: reward });
  });

  await page.goto(app.url);
  await openBusinessMenu(page, l.open);
  await button(page, l.editOne.replace('{name}', reward.name)).click();
  const name = page.getByLabel(l.name, { exact: true });
  const cost = page.getByLabel(l.costStamps, { exact: true });
  await expect(name).toHaveValue('Rabat');
  await cost.fill('7');
  await button(page, l.back).click();
  reward = { ...reward, name: 'Rabat letni', version: 2 };
  await openBusinessMenu(page, l.open);
  await expect(cost).toHaveValue('7');
  await expect(name).toHaveValue('Rabat letni');
  await button(page, l.save).click();
  await expect(page.getByText(l.updated, { exact: true })).toBeVisible();
  expect(updates).toEqual([expect.objectContaining({ name: 'Rabat letni', cost: 7, version: 2 })]);

  await button(page, l.back).click();
  await openBusinessMenu(page, l.open);
  await expect(button(page, l.editOne.replace('{name}', reward.name))).toBeVisible();
  await button(page, l.add).click();
  await expect(name).toHaveValue('');
  await expect(cost).toHaveValue('');
  await name.fill('Anulowana nagroda');
  await button(page, l.cancel).click();
  await button(page, l.back).click();
  await openBusinessMenu(page, l.open);
  await button(page, l.add).click();
  await expect(name).toHaveValue('');
});

test('team hours clears finished drafts and restores profile edits over current staff data', async ({
  page,
}) => {
  const p = pl.staffProfile;
  const s = pl.schedule;
  const member = {
    id: 'member',
    displayName: '',
    bio: '',
    active: true,
    specialties: [],
    customSpecialty: null,
    serviceIds: [],
    languages: [],
    photoUrl: null,
    version: 1,
    sortOrder: 0,
  };
  const team: (typeof member)[] = [];
  await page.route(location + '/staff', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: team });
    expect(route.request().method()).toBe('POST');
    const created = { ...member, ...route.request().postDataJSON() };
    team.push(created);
    return route.fulfill({ status: 201, json: created });
  });
  const profileUpdates: unknown[] = [];
  await page.route(location + '/staff/member', (route) => {
    expect(route.request().method()).toBe('PATCH');
    const change = route.request().postDataJSON();
    profileUpdates.push(change);
    const current = team[0]!;
    team[0] = { ...current, ...change, version: current.version + 1 };
    return route.fulfill({ json: team[0] });
  });
  await reply(page, location + '/staff/member/working-hours', {
    timezone: salon.timezone,
    weekly: [],
    overrides: [],
  });
  await reply(page, location + '/staff/member/time-off', []);

  await page.goto(app.url);
  await openBusinessMenu(page, s.teamOpen);
  await button(page, p.add).click();
  const newName = page.getByLabel(p.newName, { exact: true });
  await newName.fill('Pierwszy szkic');
  await button(page, s.back).click();
  await openBusinessMenu(page, s.teamOpen);
  await expect(newName).toHaveValue('Pierwszy szkic');
  await button(page, p.cancel).click();
  await button(page, s.back).click();
  await openBusinessMenu(page, s.teamOpen);
  await button(page, p.add).click();
  await expect(newName).toHaveValue('');
  await newName.fill('Kasia');
  await button(page, s.back).click();
  await openBusinessMenu(page, s.teamOpen);
  await expect(newName).toHaveValue('Kasia');
  await button(page, p.create).click();
  await expect(
    page.getByRole('heading', { name: s.staffTitle.replace('{name}', 'Kasia') }),
  ).toBeVisible();
  expect(team.map((staff) => staff.displayName)).toEqual(['Kasia']);

  const bio = page.getByLabel(p.bio, { exact: true });
  const name = page.getByLabel(p.name, { exact: true });
  await button(page, p.edit).click();
  await expect(name).toHaveValue('Kasia');
  await bio.fill('Strzyżenie i koloryzacja');
  await button(page, s.back).click();
  await expect(button(page, 'Kasia')).toBeVisible();
  await button(page, s.back).click();
  const staff = team[0]!;
  staff.displayName = 'Katarzyna';
  staff.version++;
  await openBusinessMenu(page, s.teamOpen);
  await button(page, p.add).click();
  await expect(newName).toHaveValue('');
  await button(page, p.cancel).click();

  await button(page, 'Katarzyna').click();
  await expect(name).toHaveValue('Katarzyna');
  await expect(bio).toHaveValue('Strzyżenie i koloryzacja');
  await button(page, p.save).click();
  await expect(page.getByText(p.saved, { exact: true })).toBeVisible();
  expect(profileUpdates).toEqual([{ bio: 'Strzyżenie i koloryzacja', version: 2 }]);
  await button(page, s.back).click();
  await expect(button(page, 'Katarzyna')).toBeVisible();
  team[0]!.bio = 'Nowy opis z salonu';
  team[0]!.version++;
  await button(page, 'Katarzyna').click();
  await button(page, p.edit).click();
  await expect(bio).toHaveValue('Nowy opis z salonu');
});
