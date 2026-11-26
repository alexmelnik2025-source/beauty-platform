import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

const org = '**/v1/organizations/dp';
const base = org + '/locations/salon';
const salon = {
  id: 'salon',
  name: 'Salon DP',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  reminderHoursBefore: 24,
  waitlistHoldMinutes: 10,
  rebookReminderDays: 14,
  rebookReminderText: null,
  version: 1,
};
const button = (scope: Page | Locator, name: string) =>
  scope.getByRole('button', { name, exact: true });

async function mockJson(page: Page, path: string, json: unknown) {
  await page.route(path, (route) => route.fulfill({ json }));
}

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app.server.close());
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'session'));
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404, json: {} }));
  await mockJson(page, '**/v1/auth/refresh', { accessToken: 'session', refreshToken: 'session' });
  await mockJson(page, '**/v1/me', {
    user: { id: 'owner' },
    organizations: [{ id: 'dp', role: 'owner', name: 'Salon DP' }],
  });
  await mockJson(page, org + '/locations', [salon]);
  await page.goto(app.url);
});

test('a failed reply stays with its review across navigation and other replies can be discarded', async ({
  page,
}) => {
  const r = pl.reviews;
  const first = {
    id: 'review-10',
    customerName: 'Anna',
    rating: 5,
    text: 'Polecam',
    staffName: 'Kasia',
    serviceName: 'Broda',
    visitStartAt: '2026-11-24T10:00:00Z',
    reply: null,
  };
  const second = { ...first, id: 'review-1', customerName: 'Ola' };
  let savedReply: string | null = null;
  await page.route(base + '/reviews', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        count: 2,
        average: 5,
        unanswered: savedReply ? 1 : 2,
        stars: [0, 0, 0, 0, 2],
        staff: [],
        services: [],
        items: [{ ...first, reply: savedReply }, second],
        nextBefore: null,
      },
    }),
  );
  await mockJson(page, base + '/review-settings', { enabled: true, requestHours: 3, version: 1 });
  const replies: string[] = [];
  let retry!: Route;
  const replyPath = base + '/reviews/' + first.id + '/reply';
  await page.route(replyPath, (route) => {
    const { text } = route.request().postDataJSON();
    replies.push(text);
    if (replies.length === 1) return route.abort();
    retry = route;
  });

  const anna = page.getByRole('group', { name: /^Anna ·/ });
  const ola = page.getByRole('group', { name: /^Ola ·/ });
  const field = (row: Locator) => row.getByRole('textbox', { name: r.replyLabel });
  const draft = '  Dziękujemy za opinię!  ';
  await openBusinessMenu(page, r.open);
  await button(anna, r.reply).click();
  await field(anna).fill(draft);
  await button(anna, r.replySave).click();
  await expect(anna.getByRole('alert')).toContainText(pl.error.network);
  await button(page, r.back).click();
  await openBusinessMenu(page, r.open);
  await expect(field(anna)).toHaveValue(draft);
  await expect(anna.getByRole('alert')).toHaveCount(0);

  await button(ola, r.reply).click();
  await expect(field(ola)).toHaveValue('');
  await field(ola).fill('Druga odpowiedź');
  await button(ola, r.replyCancel).click();
  await button(ola, r.reply).click();
  await expect(field(ola)).toHaveValue('');
  await button(anna, r.replySave).click();
  await expect.poll(() => replies.length).toBe(2);
  await button(page, r.back).click();
  await openBusinessMenu(page, r.open);
  await expect(page.getByRole('heading', { name: r.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: r.replySave, disabled: false })).toHaveCount(0);
  savedReply = retry.request().postDataJSON().text;
  await retry.fulfill({ json: { ...first, reply: savedReply } });
  await expect(anna.getByText(draft.trim(), { exact: true })).toBeVisible();
  await button(anna, r.replyChange).click();
  await expect(field(anna)).toHaveValue(draft.trim());
  expect(replies).toEqual([draft.trim(), draft.trim()]);
});

test('message edits survive a failed save while untouched settings follow the server', async ({
  page,
}) => {
  const m = pl.messages;
  const draft = '  Zapraszamy ponownie!  ';
  const writes: unknown[] = [];
  let current = { ...salon };
  await page.route(base, (route) => {
    if (route.request().method() === 'PATCH') {
      const changes = route.request().postDataJSON();
      writes.push(changes);
      if (writes.length === 1) {
        current = { ...current, waitlistHoldMinutes: 30, version: 2 };
        return route.abort();
      }
      current = { ...current, ...changes, version: 3 };
    }
    return route.fulfill({ json: current });
  });
  const days = page.getByRole('textbox', { name: m.rebookDays });
  const message = page.getByRole('textbox', { name: m.rebookText });
  await openBusinessMenu(page, m.open);
  await days.fill('21');
  await page.getByRole('switch', { name: m.rebookText }).check();
  await message.fill(draft);
  await button(page, m.save).click();
  await expect(page.getByRole('alert')).toContainText(pl.error.network);

  await button(page, m.back).click();
  await openBusinessMenu(page, m.open);
  await expect(message).toHaveValue(draft);
  await expect(days).toHaveValue('21');
  await expect(button(page, '30 min')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await button(page, m.save).click();
  await expect(page.getByText(m.saved, { exact: true })).toBeVisible();
  await button(page, m.back).click();
  await openBusinessMenu(page, m.open);
  await expect(message).toHaveValue(draft.trim());
  const changed = { rebookReminderText: draft.trim(), rebookReminderDays: 21 };
  expect(writes).toEqual([
    { ...changed, version: 1 },
    { ...changed, version: 2 },
  ]);
});

test('permission drafts restore a category and keep member exceptions separate', async ({
  page,
}) => {
  const r = pl.rights;
  const members = ['Anna', 'Ola'].map((name) => ({
    membershipId: name.toLowerCase(),
    role: 'staff',
    status: 'active',
    locationIds: [salon.id],
    user: { id: name.toLowerCase(), name },
    version: 1,
    staffCategoryId: null,
    overrides: {},
  }));
  await mockJson(page, base + '/staff', []);
  await mockJson(page, org + '/invitations', []);
  await mockJson(page, org + '/members', members);
  await mockJson(page, org + '/permissions', {
    permissions: [{ key: 'viewClientContacts', default: false }],
    me: { role: 'owner', permissions: {} },
  });
  const name = 'Starszy barber';
  await page.route(org + '/staff-categories', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        json: { ...route.request().postDataJSON(), id: 'senior', version: 1, memberCount: 0 },
      });
    }
    return route.fulfill({ json: [] });
  });

  // Task 844: after PR #127 (DI) "Uprawnienia" sits under the team screen's "Więcej ▸".
  const openRights = async () => {
    const more = button(page, pl.navigation.more);
    await expect(more).toBeVisible();
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
    await button(page, r.open).click();
  };
  await openBusinessMenu(page, pl.team.open);
  await openRights();
  await button(page, r.addCategory).click();
  const field = page.getByRole('textbox', { name: r.categoryName });
  const contacts = page.getByRole('checkbox', { name: r.names.viewClientContacts });
  await field.fill(name);
  await contacts.click();
  await button(page, r.back).click();
  await openRights();
  await expect(field).toHaveValue(name);
  await expect(contacts).toBeChecked();
  await button(page, r.save).click();
  await expect(page.getByText(r.categorySaved, { exact: true })).toBeVisible();
  await button(page, r.addCategory).click();
  await expect(field).toHaveValue('');
  await expect(contacts).not.toBeChecked();
  await button(page, r.cancel).click();

  const edit = (member: string) => button(page, r.change + ': ' + member);
  const allow = page.getByRole('radio', { name: r.names.viewClientContacts + ': ' + r.allow });
  await edit('Anna').click();
  await allow.click();
  await button(page, r.back).click();
  await openRights();
  await expect(allow).toBeChecked();
  await edit('Ola').click();
  await expect(allow).not.toBeChecked();
  await edit('Anna').click();
  await expect(allow).toBeChecked();
  await button(page, r.cancel).click();
  await edit('Anna').click();
  await expect(allow).not.toBeChecked();
});
