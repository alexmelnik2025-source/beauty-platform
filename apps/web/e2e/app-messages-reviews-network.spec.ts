import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

const org = '/v1/organizations/cc';
const base = org + '/locations/salon';
const location = {
  id: 'salon',
  name: 'Salon CC',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  city: 'Warszawa',
  reminderHoursBefore: 24,
  waitlistHoldMinutes: 10,
  rebookReminderDays: 14,
  rebookReminderText: 'Zapraszamy',
  version: 1,
};
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => {
  app.server.close();
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('beauty.business.refreshToken', 'cc-session'),
  );
  await page.route('**/v1/**', (route) => route.abort());
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({ json: { accessToken: 'cc-access', refreshToken: 'cc-session' } }),
  );
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'owner' },
        organizations: [{ id: 'cc', name: 'Salon CC', role: 'owner' }],
      },
    }),
  );
  await page.route('**' + org + '/locations', (route) => route.fulfill({ json: [location] }));
  await page.goto(app.url);
  await page.getByRole('tab', { name: pl.navigation.more }).click();
});

async function readError(page: Page) {
  await expect(page.getByRole('alert')).toHaveText(pl.error.network);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
}

async function failThenRetryWrite(
  page: Page,
  path: string,
  method: string,
  field: Locator,
  save: Locator,
  draft: string,
  payloadKey: string,
  response: object,
) {
  const writes: unknown[] = [];
  let first!: Route;
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    writes.push(route.request().postDataJSON()[payloadKey]);
    if (writes.length === 1) first = route;
    else await route.fulfill({ json: response });
  });
  await field.fill(draft);
  // Two events in the same turn, before React can paint the pending state.
  await save.evaluate((el) => {
    (el as HTMLElement).click();
    (el as HTMLElement).click();
  });
  await expect(save).toBeDisabled();
  await expect.poll(() => writes.length).toBe(1);
  await first.abort('connectionreset');
  await expect(page.getByRole('alert')).toContainText(pl.error.network);
  await expect(field).toHaveValue(draft);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => writes).toEqual([draft, draft]);
}

test('a stalled template load can be retried and a failed save keeps the draft', async ({
  page,
}) => {
  const m = pl.messages;
  await page.clock.install();
  await page.route('**' + base, (route) => route.fulfill({ json: location }));
  let stalled!: Route;
  await page.route(
    '**' + base,
    (route) => {
      stalled = route;
    },
    { times: 1 },
  );
  await openBusinessMenu(page, m.open);
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect.poll(() => !!stalled).toBe(true);
  await page.clock.fastForward(31_000);
  await readError(page);
  await button(page, pl.day.refresh).click();
  const field = page.getByRole('textbox', { name: m.rebookText });
  await expect(field).toHaveValue(location.rebookReminderText);
  await stalled.fulfill({ json: { ...location, rebookReminderText: 'Stara wersja' } });
  const draft = 'Wracaj do nas!';
  await failThenRetryWrite(
    page,
    base,
    'PATCH',
    field,
    button(page, m.save),
    draft,
    'rebookReminderText',
    { ...location, rebookReminderText: draft, version: 2 },
  );
  await expect(page.getByText(m.saved)).toBeVisible();
  await expect(field).toHaveValue(draft);
});

test('notifications survive an interrupted refresh until a successful retry', async ({ page }) => {
  const n = pl.notifications;
  const path = '**/v1/me/notifications?*';
  const notice = {
    id: 'notice',
    organizationId: 'cc',
    appointmentId: null,
    type: 'appointment.cancelled',
    read: true,
    data: {
      locationId: 'salon',
      date: '2026-11-24',
      time: '10:30',
      by: 'client',
      customerName: 'Anna',
      serviceName: 'Broda',
      staffName: 'Kasia',
    },
  };
  await page.route(path, (route) => route.fulfill({ json: [notice] }));
  await page.route(path, (route) => route.abort(), { times: 1 });
  await openBusinessMenu(page, n.open);
  await readError(page);
  const refresh = button(page, pl.day.refresh);
  await refresh.click();
  const row = page.getByRole('listitem', { name: /Anna · Broda · Kasia/ });
  await expect(row).toBeVisible();
  await page.route(path, (route) => route.abort(), { times: 1 });
  await refresh.click();
  await readError(page);
  await expect(row).toBeVisible();
  await page.route(path, (route) => route.fulfill({ json: [] }), { times: 1 });
  await refresh.click();
  await expect(page.getByText(n.empty)).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('history retries the failed page and keeps newer entries', async ({ page }) => {
  const h = pl.history;
  const path = '**' + org + '/audit-log?*';
  const entry = {
    id: 'new',
    action: 'service.created',
    at: '2026-11-24T10:00:00Z',
    entityName: 'Broda',
  };
  const cursors: (string | null)[] = [];
  await page.route(path, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('before');
    cursors.push(cursor);
    if (cursors.length === 1 || cursors.length === 3) return route.abort();
    return route.fulfill({
      json: cursor
        ? { items: [{ ...entry, id: 'old', entityName: 'Golenie' }], next: null }
        : { items: [entry], next: 'older' },
    });
  });
  await openBusinessMenu(page, h.open);
  await readError(page);
  await button(page, pl.day.refresh).click();
  const newer = page.getByRole('listitem', { name: /Broda/ });
  await expect(newer).toBeVisible();
  await button(page, h.more).click();
  await readError(page);
  await expect(newer).toBeVisible();
  await button(page, pl.day.refresh).click();
  await expect(page.getByRole('listitem', { name: /Golenie/ })).toBeVisible();
  await expect(newer).toHaveCount(1);
  expect(cursors).toEqual([null, null, 'older', 'older']);
});

test('reviews survive a failed filter request and publish the preserved reply once on retry', async ({
  page,
}) => {
  const r = pl.reviews;
  const review = {
    id: 'review',
    rating: 4,
    text: 'Świetna wizyta',
    staffName: 'Kasia',
    serviceName: 'Broda',
    customerName: 'Anna',
    visitStartAt: '2026-11-20T10:00:00Z',
    reply: null,
  };
  const list = {
    enabled: true,
    count: 1,
    average: 4,
    stars: [0, 0, 0, 1, 0],
    unanswered: 1,
    staff: [],
    services: [],
    items: [review],
    nextBefore: null,
  };
  const path = '**' + base + '/reviews';
  await page.route('**' + base + '/review-settings', (route) =>
    route.fulfill({ json: { enabled: true, requestHours: 3, version: 1 } }),
  );
  await page.route(path, (route) => route.fulfill({ json: list }));
  await page.route(path, (route) => route.abort(), { times: 1 });
  await openBusinessMenu(page, r.open);
  await readError(page);
  await button(page, pl.day.refresh).click();
  const text = page.getByText(review.text, { exact: true });
  await expect(text).toBeVisible();
  await page.route(path + '?unanswered=true', (route) => route.fulfill({ json: list }));
  await page.route(path + '?unanswered=true', (route) => route.abort(), { times: 1 });
  await button(page, 'Bez odpowiedzi (1)').click();
  await readError(page);
  await expect(text).toBeVisible();
  await button(page, pl.day.refresh).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await button(page, r.reply).click();
  const draft = 'Dziękujemy za opinię!';
  await failThenRetryWrite(
    page,
    base + '/reviews/review/reply',
    'PUT',
    page.getByRole('textbox', { name: r.replyLabel }),
    button(page, r.replySave),
    draft,
    'text',
    { ...review, reply: draft },
  );
  await expect(page.getByText(r.none)).toBeVisible();
});
