import { expect, test, type Page, type Route } from '@playwright/test';
import { dayTitle } from '../../mobile-business/src/day';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const today = '2026-11-26';
const tomorrow = '2026-11-27';
const salon = '/v1/organizations/org/locations/salon';
const location = { id: 'salon', name: 'Studio DX', timezone: 'Europe/Warsaw', currency: 'PLN' };
const service = {
  id: 'cut',
  name: 'Strzyżenie',
  active: true,
  durationMinutes: 30,
  priceGrosze: 8000,
  sortOrder: 0,
  staffIds: ['anna'],
};
const staff = {
  id: 'anna',
  displayName: 'Anna',
  active: true,
  serviceIds: [service.id],
  sortOrder: 0,
};
const button = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: true });

function slot(date: string, hour: number) {
  const time = `${hour.toString().padStart(2, '0')}:00`;
  return {
    date,
    time,
    start: `${date}T${(hour - 1).toString().padStart(2, '0')}:00:00Z`,
    staffIds: [staff.id],
  };
}

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 844 }, locale: 'pl-PL', isMobile: true });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(today + 'T07:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  const replies: Record<string, unknown> = {
    '/v1/auth/refresh': { accessToken: 'test' },
    '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner' }] },
    '/v1/organizations/org/locations': [location],
    '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
    [salon + '/calendar']: {
      from: today,
      location,
      staff: [{ ...staff, days: [] }],
      appointments: [],
    },
    [salon + '/time-blocks']: [],
    [salon + '/staff']: [staff],
    [salon + '/services']: [service],
    [salon + '/availability']: { durationMinutes: 30, slots: [slot(today, 10)] },
  };
  await page.route('**/v1/**', (route) => {
    const { pathname } = new URL(route.request().url());
    return pathname in replies
      ? route.fulfill({ json: replies[pathname] })
      : route.fulfill({ status: 404 });
  });
  await page.goto(app.url);
  await expect(button(page, pl.newVisit.open)).toBeVisible();
  const day = page.getByRole('heading', { name: dayTitle(today, 'pl'), exact: true });
  const size = () => day.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await size();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await size()).toBeCloseTo(normal * 1.3, 1);
});

async function openNewVisit(page: Page) {
  await button(page, pl.newVisit.open).click();
  await expect(page.getByRole('heading', { name: pl.newVisit.title })).toBeVisible();
}

async function chooseService(page: Page) {
  await button(page, /^Strzyżenie ·/).click();
}

test('the selected time stays pressed when a response arrives late for the previous date', async ({
  page,
}) => {
  let delayed: Route | undefined;
  await page.route('**' + salon + '/availability?*', (route) => {
    const date = new URL(route.request().url()).searchParams.get('from');
    if (date === today) {
      delayed = route;
      return;
    }
    expect(date).toBe(tomorrow);
    return route.fulfill({
      json: { durationMinutes: 30, slots: [slot(tomorrow, 14), slot(tomorrow, 15)] },
    });
  });
  await openNewVisit(page);
  await chooseService(page);
  await expect.poll(() => !!delayed).toBe(true);
  await button(page, pl.newVisit.nextDay).click();
  const first = button(page, '14:00');
  const second = button(page, '15:00');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(second).toHaveAttribute('aria-pressed', 'false');

  const stale = delayed!;
  await Promise.all([
    page.waitForEvent('requestfinished', (request) => request === stale.request()),
    stale.fulfill({ json: { durationMinutes: 30, slots: [slot(today, 10)] } }),
  ]);
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await second.click();
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(button(page, '10:00')).toHaveCount(0);
});

for (const resource of ['services', 'staff']) {
  test(`the owner retries the form after the first ${resource} request loses connection`, async ({
    page,
  }) => {
    await page.route('**' + salon + '/' + resource, (route) => route.abort('connectionreset'), {
      times: 1,
    });
    await openNewVisit(page);
    const failure = page.getByRole('alert').filter({ hasText: pl.error.network });
    const retry = button(page, pl.day.refresh);
    await expect(failure).toBeVisible();
    await retry.click();
    await chooseService(page);
    await expect(page.getByRole('textbox', { name: pl.newVisit.search })).toBeVisible();
    await expect(failure).toHaveCount(0);
    await expect(retry).toHaveCount(0);
  });
}

test('client search distinguishes an empty result from an interrupted lookup and retries the same name', async ({
  page,
}) => {
  await openNewVisit(page);
  await chooseService(page);
  const queries: string[] = [];
  await page.route('**/v1/organizations/org/customers?*', (route) => {
    const query = new URL(route.request().url()).searchParams.get('search');
    if (query === null) return route.fallback();
    queries.push(query);
    if (query === 'Zo') return route.fulfill({ json: [] });
    if (queries.length === 2) return route.abort('connectionreset');
    return route.fulfill({ json: [{ id: 'ewa', name: 'Ewa Nowak', phone: null, email: null }] });
  });
  const search = page.getByRole('textbox', { name: pl.newVisit.search });
  const noResults = page.getByText(pl.newVisit.noResults, { exact: true });
  const failure = page.getByRole('alert').filter({ hasText: pl.error.network });
  await search.fill('Zo');
  await expect(noResults).toBeVisible();
  await search.fill('Ew');
  await expect(failure).toBeVisible();
  await expect(search).toHaveValue('Ew');
  await expect(noResults).toHaveCount(0);

  await button(page, pl.day.refresh).click();
  await button(page, 'Ewa Nowak').click();
  await expect(page.getByText('✓ Ewa Nowak', { exact: true })).toBeVisible();
  await expect(failure).toHaveCount(0);
  expect(queries).toEqual(['Zo', 'Ew', 'Ew']);
});

test('two save presses submit one appointment and a retry keeps the selected start', async ({
  page,
}) => {
  const appointments = '**' + salon + '/appointments';
  const start = today + 'T09:00:00Z';
  const submittedStarts: string[] = [];
  let release!: () => void;
  const firstAttempt = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retry = false;
  await page.route(appointments, async (route) => {
    expect(route.request().method()).toBe('POST');
    submittedStarts.push(route.request().postDataJSON().start);
    if (retry) return route.fulfill({ status: 201, json: { id: 'saved', date: today } });
    await firstAttempt;
    return route.abort();
  });

  await openNewVisit(page);
  await chooseService(page);
  const time = button(page, '10:00');
  const background = () => time.evaluate((el) => getComputedStyle(el).backgroundColor);
  const unselected = await background();
  await time.click();
  await expect(time).not.toHaveCSS('background-color', unselected);
  const selected = await background();
  await page.getByLabel(pl.newVisit.name, { exact: true }).fill('Jan Kowalski');
  await page.getByLabel(pl.newVisit.phone, { exact: true }).fill('600100200');
  const save = button(page, pl.newVisit.save);
  try {
    await Promise.all([
      page.waitForRequest(appointments),
      // Activate twice in the same turn, before React can disable the button.
      save.evaluate((el: HTMLElement) => {
        el.click();
        el.click();
      }),
    ]);
    await expect(save).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('alert')).toContainText(pl.error.network);
  expect(submittedStarts).toEqual([start]);
  await expect(time).toHaveAttribute('aria-pressed', 'true');
  await expect(time).toHaveCSS('background-color', selected);

  retry = true;
  await Promise.all([page.waitForRequest(appointments + '/saved'), save.click()]);
  await expect(page.getByRole('heading', { name: pl.newVisit.title })).toHaveCount(0);
  expect(submittedStarts).toEqual([start, start]);
});
