import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { ClientAppointment, ClientWaitlistEntry, Locale } from '../../mobile-client/src/api';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const salon = {
  name: 'Studio DW',
  slug: 'studio-dw',
  addressLine: 'Prosta 1',
  city: 'Warszawa',
  postalCode: '00-001',
  phone: null,
  timezone: 'Europe/Warsaw',
};
const completed: ClientAppointment = {
  id: 'completed',
  status: 'completed',
  date: '2026-11-20',
  time: '12:00',
  start: '2026-11-20T11:00:00Z',
  end: '2026-11-20T11:30:00Z',
  timezone: salon.timezone,
  currency: 'PLN',
  salon,
  service: { id: 'cut', name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 7000 },
  staff: { id: 'ola', displayName: 'Ola' },
  changeableUntil: '2026-11-19T11:00:00Z',
  canChange: false,
  awaitingApproval: false,
  wishes: { mood: null, drink: null, note: null },
  wishQuestions: { mood: false, drinks: [], note: false },
  canChangeWishes: false,
  bookAgain: null,
  discountGrosze: 0,
  coupons: [],
};
const email = 'dw@example.com';
let app: Awaited<ReturnType<typeof serveApp>>;

test.use({ viewport: { width: 320, height: 640 }, isMobile: true });
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'dw-client'));
  await page.route('**/v1/client/appointments?scope=*', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/client/waitlist', (route) => route.fulfill({ json: { items: [] } }));
});

async function openVisits(page: Page, locale: Locale) {
  await page.route('**/v1/client/me', (route) =>
    route.fulfill({ json: { id: 'dw', email, locale } }),
  );
  await page.goto(app.url);
  const t = DICTIONARIES[locale];
  const heading = page.getByRole('heading', { name: t.visits.title, exact: true });
  await expect(heading).toBeVisible();
  const fontSize = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
  await expect(page.getByText(t.visits.emptyUpcoming, { exact: true })).toBeVisible();
  return t;
}

async function doubleTap(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await button.evaluate((node: HTMLElement) => {
    node.click();
    node.click();
  });
}

// Keep the operation pending so the second tap arrives before the first response.
async function holdRequest(page: Page, path: string, method: string) {
  const requests: Route[] = [];
  await page.route(path, (route) => {
    expect(route.request().method()).toBe(method);
    requests.push(route);
  });
  return requests;
}

test('a late history response leaves upcoming visits empty', async ({ page }) => {
  const summary = { completed: 1, salons: 1, firstVisitAt: completed.start, spent: [] };
  await page.route('**/v1/client/appointments?scope=past', (route) =>
    route.fulfill({ json: { items: [completed] } }),
  );
  const summaries = await holdRequest(page, '**/v1/client/me/summary', 'GET');
  const t = await openVisits(page, 'pl');
  const past = page.getByRole('tab', { name: t.visits.past, exact: true });
  const upcoming = page.getByRole('tab', { name: t.visits.upcoming, exact: true });
  const empty = page.getByText(t.visits.emptyUpcoming, { exact: true });
  const card = page.getByRole('button', {
    name: `${completed.time} ${completed.service.name}, ${salon.name}`,
    exact: true,
  });
  await past.click();
  await expect.poll(() => summaries.length).toBe(1);
  await upcoming.click();
  await expect(empty).toBeVisible();
  const delivered = page.waitForEvent('requestfinished', (req) =>
    req.url().endsWith('/me/summary'),
  );
  await summaries[0]!.fulfill({ json: summary });
  await delivered;
  // Give React a paint after the old payload arrives before asserting that it stayed off-screen.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await expect(upcoming).toHaveAttribute('aria-selected', 'true');
  await expect(empty).toBeVisible();
  await expect(card).toHaveCount(0);

  await past.click();
  await expect.poll(() => summaries.length).toBe(2);
  await summaries[1]!.fulfill({ json: summary });
  await expect(card).toBeVisible();
});

test('double tapping Leave sends one cancellation and removes the entry', async ({ page }) => {
  const entry: ClientWaitlistEntry = {
    id: 'waiting',
    salon,
    date: '2026-12-02',
    serviceId: completed.service.id,
    serviceName: completed.service.name,
    staffId: null,
    staffName: null,
    status: 'waiting',
    createdAt: '2026-11-20T11:00:00Z',
    notifiedAt: null,
    autoBook: false,
  };
  await page.route('**/v1/client/waitlist', (route) => route.fulfill({ json: { items: [entry] } }));
  const cancels = await holdRequest(page, '**/v1/client/waitlist/waiting/cancel', 'POST');
  const t = await openVisits(page, 'uk');
  const leave = page.getByRole('button', { name: new RegExp('^' + t.waitlist.leave + ':') });
  await doubleTap(leave);
  await expect(leave).toBeDisabled();
  await expect.poll(() => cancels.length).toBe(1);
  await cancels[0]!.fulfill({ json: { ...entry, status: 'cancelled' } });
  await expect(page.getByText(entry.serviceName, { exact: true })).toHaveCount(0);
  expect(cancels).toHaveLength(1);
});

test('double tapping Sign out ends the session with one request', async ({ page }) => {
  const logouts = await holdRequest(page, '**/v1/client/auth/logout', 'POST');
  await page.route('**/v1/public/locations?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, openNowCount: 0 } }),
  );
  const t = await openVisits(page, 'ru');
  await page.getByRole('button', { name: t.visits.profile, exact: true }).click();
  const signOut = page.getByRole('button', { name: t.visits.signOut, exact: true });
  await doubleTap(signOut);
  await expect(signOut).toBeDisabled();
  await expect.poll(() => logouts.length).toBe(1);
  await logouts[0]!.fulfill({ status: 204 });
  await expect(page.getByRole('textbox', { name: t.signIn.email, exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('beauty.client.session'))).toBeNull();
  expect(logouts).toHaveLength(1);
});

test('retry beneath an export error downloads the requested file', async ({ page }) => {
  const file = {
    exportedAt: '2026-11-26T16:50:00Z',
    person: { email, locale: 'en', createdAt: '2026-01-01T12:00:00Z' },
    salons: [],
  };
  let exports = 0;
  await page.route('**/v1/client/export', (route) => {
    expect(route.request().method()).toBe('GET');
    return ++exports === 1 ? route.abort('internetdisconnected') : route.fulfill({ json: file });
  });
  const t = await openVisits(page, 'en');
  await page.getByRole('button', { name: t.visits.profile, exact: true }).click();
  await page.getByRole('button', { name: t.visits.downloadData, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(t.error.network);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: t.retry, exact: true }).click(),
  ]);
  expect(exports).toBe(2);
  expect(download.suggestedFilename()).toBe('my-data-2026-11-26.json');
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(file);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('removing the last favourite after reconnecting clears its network error', async ({
  page,
}) => {
  const favorite = { ...salon, addedAt: '2026-11-20T11:00:00Z', bookable: false, todayHours: [] };
  await page.route('**/v1/client/favorites', (route) =>
    route.fulfill({ json: { items: [favorite] } }),
  );
  let removals = 0;
  await page.route('**/v1/client/favorites/studio-dw', (route) => {
    expect(route.request().method()).toBe('DELETE');
    return ++removals === 1 ? route.abort('internetdisconnected') : route.fulfill({ status: 204 });
  });
  const t = await openVisits(page, 'pl');
  await page.getByRole('tab', { name: t.favorites.tab, exact: true }).click();
  await page.getByRole('button', { name: t.catalog.more, exact: true }).click();
  const remove = page.getByRole('button', {
    name: `${t.favorites.remove}: ${salon.name}`,
    exact: true,
  });
  await remove.click();
  await expect(page.getByRole('alert')).toHaveText(t.error.network);
  await expect(page.getByRole('heading', { name: salon.name })).toBeVisible();
  await remove.click();
  await expect(page.getByText(t.favorites.empty, { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(removals).toBe(2);
});
