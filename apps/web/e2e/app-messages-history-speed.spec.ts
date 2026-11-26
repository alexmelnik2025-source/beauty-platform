import { expect, test, type Route } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

const org = '/v1/organizations/cn';
const locationPath = org + '/locations/salon';
const location = {
  id: 'salon',
  name: 'Salon CN',
  timezone: 'Europe/Warsaw',
  reminderHoursBefore: 24,
  waitlistHoldMinutes: 10,
  rebookReminderDays: 14,
  rebookReminderText: 'Zapraszamy',
  version: 1,
};
const auditPath = '**' + org + '/audit-log?*';
function historyEntry(id: string) {
  return { id, entityName: id, action: 'service.created', at: '2026-11-24T10:00:00Z' };
}

function notice(name: string) {
  return {
    id: name,
    organizationId: 'cn',
    appointmentId: null,
    read: false,
    type: 'appointment.cancelled',
    data: {
      locationId: 'salon',
      date: '2026-11-24',
      time: '10:00',
      by: 'client',
      customerName: name,
      serviceName: 'Broda',
      staffName: 'Jan',
    },
  };
}

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => {
  app.server.close();
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'cn-test'));
  await page.route('**/v1/**', (route) => route.abort());
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({ json: { accessToken: 'cn-access', refreshToken: 'cn-test' } }),
  );
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      json: { user: { id: 'owner' }, organizations: [{ id: 'cn', role: 'owner', name: 'CN' }] },
    }),
  );
  await page.route('**' + org + '/locations', (route) => route.fulfill({ json: [location] }));
  await page.goto(app.url);
  await page.getByRole('tab', { name: pl.navigation.more }).click();
});

test('typing and returning to message settings reuse the saved location', async ({ page }) => {
  let reads = 0;
  await page.route('**' + locationPath, (route) => {
    reads++;
    return route.fulfill({ json: location });
  });
  const m = pl.messages;
  await openBusinessMenu(page, m.open);
  const field = page.getByRole('textbox', { name: m.rebookText });
  await expect(field).toHaveValue(location.rebookReminderText);
  await field.press('End');
  await field.pressSequentially('12345');
  await expect(field).toHaveValue(location.rebookReminderText + '12345');
  await page.getByRole('button', { name: m.back, exact: true }).click();
  await openBusinessMenu(page, m.open);
  await expect(field).toHaveValue(location.rebookReminderText + '12345');
  expect(reads).toBe(1);
});

test('reading one notification and then all preserves the list on return', async ({ page }) => {
  const n = pl.notifications;
  const notices = ['Anna', 'Ewa', 'Ola'].map(notice);
  let reads = 0;
  const writes: unknown[] = [];
  await page.route('**/v1/me/notifications?*', (route) => {
    reads++;
    return route.fulfill({ json: notices });
  });
  await page.route('**/v1/me/notifications/read', (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { updated: 1 } });
  });

  await openBusinessMenu(page, n.open);
  await page.getByRole('button', { name: /Anna · Broda/ }).click();
  const read = page.getByRole('listitem', { name: /Anna · Broda/ });
  await expect(read).toBeVisible();
  await page.getByRole('button', { name: n.readAll }).click();
  await expect(page.getByRole('listitem', { name: /Ewa · Broda/ })).toBeVisible();
  await page.getByRole('button', { name: n.back, exact: true }).click();
  await openBusinessMenu(page, n.open);
  await expect(read).toBeVisible();
  await expect(page.getByRole('button', { name: n.readAll })).toHaveCount(0);
  expect(reads).toBe(1);
  expect(writes).toEqual([{ ids: ['Anna'] }, { all: true }]);
});

test('history fetches each cursor once and reopens with both pages', async ({ page }) => {
  const h = pl.history;
  const cursors: (string | null)[] = [];
  await page.route(auditPath, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('before');
    cursors.push(cursor);
    return route.fulfill({
      json: cursor
        ? { items: [historyEntry('Starszy wpis')], next: null }
        : { items: [historyEntry('Nowy wpis')], next: 'older' },
    });
  });
  await openBusinessMenu(page, h.open);
  const older = page.getByRole('listitem', { name: /Starszy wpis/ });
  const newer = page.getByRole('listitem', { name: /Nowy wpis/ });
  await expect(newer).toBeVisible();
  await page.getByRole('button', { name: h.more }).evaluate((button) => {
    (button as HTMLElement).click();
    (button as HTMLElement).click();
  });
  await expect(older).toBeVisible();
  await page.getByRole('button', { name: h.back, exact: true }).click();
  await openBusinessMenu(page, h.open);
  await expect(newer).toBeVisible();
  await expect(older).toBeVisible();
  expect(cursors).toEqual([null, 'older']);
});

test('leaving history drops the unfinished read and ignores its late response', async ({
  page,
}) => {
  const h = pl.history;
  let first: Route | undefined;
  let reads = 0;
  await page.route(auditPath, (route) => {
    reads++;
    if (!first) {
      first = route;
      return;
    }
    return route.fulfill({ json: { items: [historyEntry('Aktualny wpis')], next: null } });
  });
  await openBusinessMenu(page, h.open);
  await expect.poll(() => reads).toBe(1);
  await page.getByRole('button', { name: h.back, exact: true }).click();
  await openBusinessMenu(page, h.open);
  const current = page.getByRole('listitem', { name: /Aktualny wpis/ });
  await expect(current).toBeVisible();
  await first!.fulfill({ json: { items: [historyEntry('Nieaktualny wpis')], next: null } });
  await page.getByRole('button', { name: h.back, exact: true }).click();
  await openBusinessMenu(page, h.open);
  await expect(current).toBeVisible();
  expect(reads).toBe(2);
});

test('an empty salon inbox checks one recent item and finds arrivals even if already read', async ({
  page,
}) => {
  const n = pl.notifications;
  const elsewhere = { ...notice('Ewa'), data: { ...notice('Ewa').data, locationId: 'elsewhere' } };
  const arrived = { ...notice('Nowa'), read: true };
  const feed = [elsewhere];
  const limits: number[] = [];
  await page.route('**/v1/me/notifications?*', (route) => {
    const limit = Number(new URL(route.request().url()).searchParams.get('limit'));
    limits.push(limit);
    return route.fulfill({ json: feed.slice(0, limit) });
  });
  const back = page.getByRole('button', { name: n.back, exact: true });
  await openBusinessMenu(page, n.open);
  await expect(page.getByText(n.empty)).toBeVisible();
  await back.click();
  await openBusinessMenu(page, n.open);
  await expect.poll(() => limits).toEqual([100, 1]);
  await expect(page.getByText(n.empty)).toBeVisible();
  await back.click();
  feed.unshift(arrived);
  await openBusinessMenu(page, n.open);
  await expect(page.getByRole('listitem', { name: /Nowa · Broda/ })).toBeVisible();
  expect(limits).toEqual([100, 1, 1, 100]);
});
