import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, fill, type Dictionary } from '../../mobile-business/src/i18n';
import { serveApp } from './mobile-app';

const org = '**/v1/organizations/org';
const loyalty = org + '/loyalty';
const location = org + '/locations/salon';
const salon = { id: 'salon', name: 'Studio', timezone: 'Europe/Warsaw', currency: 'PLN' };
const tiers = { basis: 'visits', periodDays: 90, tiers: [] };
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const reply = (page: Page, path: string, json: unknown) =>
  page.route(path, (route) => route.fulfill({ json }));

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'refresh'));
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await reply(page, '**/v1/auth/refresh', { accessToken: 'access', refreshToken: 'refresh' });
  await reply(page, '**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'org', name: salon.name, role: 'owner' }],
  });
  await reply(page, org + '/locations', [salon]);
  await reply(page, org + '/members', []);
  await reply(page, org + '/invitations', []);
  await reply(page, location + '/staff', []);
  await reply(page, location + '/services', []);
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
  await reply(page, loyalty + '/rewards', []);
  await reply(page, loyalty + '/tiers', tiers);
  await reply(page, loyalty + '/bonus-rules', { rules: [] });
});

async function openScreen(page: Page, t: Dictionary, screen: 'team' | 'loyalty') {
  await page.goto(app.url);
  await page.getByRole('tab', { name: t.navigation.more, exact: true }).click();
  await button(page, t[screen].open).click();
  const heading = page.getByRole('heading', { name: t[screen].title, exact: true });
  const fontSize = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(original * 1.3, 1);
  expect(await page.evaluate(() => innerWidth)).toBe(320);
}

// Check both windows for a duplicate: before React renders busy and while the spinner is visible.
async function failFirstSave(
  page: Page,
  save: Locator,
  path: string,
  method: 'POST' | 'PUT',
  saved: unknown,
  networkError: string,
) {
  const writes: unknown[] = [];
  let response: Promise<boolean>;
  await page.route(path, async (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    expect(route.request().method()).toBe(method);
    writes.push(route.request().postDataJSON());
    if (await response) return route.fulfill({ json: saved });
    await route.abort('internetdisconnected');
  });

  async function submit(online: boolean) {
    let release!: (online: boolean) => void;
    response = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    await save.scrollIntoViewIfNeeded();
    const before = await save.boundingBox();
    expect(before).toBeTruthy();
    try {
      await save.evaluate((el: HTMLElement) => {
        el.click();
        el.click();
      });
      await expect.poll(() => writes.length).toBe(online ? 2 : 1);
      await expect(save).toBeDisabled();
      expect(await save.boundingBox()).toEqual(before);
      await page.touchscreen.tap(before!.x + before!.width / 2, before!.y + before!.height / 2);
      await expect(save).toBeDisabled();
    } finally {
      release(online);
    }
  }

  await submit(false);
  await expect(page.getByRole('alert').filter({ hasText: networkError })).toBeVisible();
  await expect(save).toBeEnabled();
  expect(writes).toHaveLength(1);
  return async () => {
    await submit(true);
    await expect(save).toBeHidden();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  };
}

test.describe('team invitation', () => {
  test.use({ locale: 'en-GB' });
  test('a second tap leaves the invitation and its email in place', async ({ page }) => {
    const t = DICTIONARIES.en;
    await openScreen(page, t, 'team');
    await button(page, t.team.newPerson).click();
    const email = page.getByLabel(t.team.email, { exact: true });
    await email.fill('invite@example.com');
    const retry = await failFirstSave(
      page,
      button(page, t.team.send),
      org + '/invitations',
      'POST',
      { id: 'invite' },
      t.error.network,
    );
    await expect(email).toHaveValue('invite@example.com');
    await retry();
    await expect(
      page.getByText(fill(t.team.sent, { email: 'invite@example.com' }), { exact: true }),
    ).toBeVisible();
  });
});

test.describe('loyalty tiers and extra rules', () => {
  test.use({ locale: 'pl-PL' });
  const t = DICTIONARIES.pl;
  const l = t.loyalty;

  test('a second tap keeps the edited tier period', async ({ page }) => {
    await openScreen(page, t, 'loyalty');
    await button(page, l.tiersChange).click();
    const period = page.getByLabel(l.tierPeriod, { exact: true });
    await period.fill('180');
    const retry = await failFirstSave(
      page,
      button(page, l.tiersSave),
      loyalty + '/tiers',
      'PUT',
      { ...tiers, periodDays: 180 },
      t.error.network,
    );
    await expect(period).toHaveValue('180');
    await retry();
    await expect(page.getByText(l.tiersSaved, { exact: true })).toBeVisible();
  });

  test('a second tap leaves the empty bonus rule list unchanged', async ({ page }) => {
    await openScreen(page, t, 'loyalty');
    await button(page, l.bonusChange).click();
    const retry = await failFirstSave(
      page,
      button(page, l.bonusSave),
      loyalty + '/bonus-rules',
      'PUT',
      { rules: [] },
      t.error.network,
    );
    await expect(page.getByLabel(fill(l.bonusName, { n: '1' }), { exact: true })).toHaveCount(0);
    await retry();
    await expect(page.getByText(l.bonusSaved, { exact: true })).toBeVisible();
  });
});

test.describe('reward editor', () => {
  test.use({ locale: 'uk-UA' });
  test('the corrected discount and reward stay in the editor through a failed save', async ({
    page,
  }) => {
    const t = DICTIONARIES.uk;
    const l = t.loyalty;
    await openScreen(page, t, 'loyalty');
    await button(page, l.add).click();
    const name = page.getByLabel(l.name, { exact: true });
    const percent = page.getByLabel(l.percent, { exact: true });
    const cost = page.getByLabel(l.costStamps, { exact: true });
    await name.fill('Welcome');
    await percent.fill('101');
    await cost.fill('5');
    await button(page, l.save).click();
    await expect(percent).toHaveAttribute('aria-invalid', 'true');
    await percent.fill('25');
    await expect(percent).not.toHaveAttribute('aria-invalid', 'true');
    const retry = await failFirstSave(
      page,
      button(page, l.save),
      loyalty + '/rewards',
      'POST',
      { id: 'welcome' },
      t.error.network,
    );
    await expect(name).toHaveValue('Welcome');
    await expect(percent).toHaveValue('25');
    await expect(cost).toHaveValue('5');
    await retry();
    await expect(page.getByText(l.added, { exact: true })).toBeVisible();
  });
});
