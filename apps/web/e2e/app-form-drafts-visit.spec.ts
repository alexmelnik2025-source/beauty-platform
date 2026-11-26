import { expect, test, type Page } from '@playwright/test';
import { dayTitle } from '../../mobile-business/src/day';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const today = '2026-11-25';
const tomorrow = '2026-11-26';
const salon = '/v1/organizations/org/locations/salon';
const location = { id: 'salon', name: 'Studio DL', timezone: 'Europe/Warsaw', currency: 'PLN' };
const visit = {
  id: 'first',
  version: 1,
  date: today,
  time: '12:00',
  start: today + 'T11:00:00Z',
  end: today + 'T11:30:00Z',
  status: 'confirmed',
  service: { id: 'cut', name: 'Strzyżenie' },
  staff: { id: 'anna', displayName: 'Anna' },
  customer: null,
  priceGrosze: 8000,
  durationMinutes: 30,
  paidAt: null,
  tipGrosze: 0,
};
const otherVisit = {
  ...visit,
  id: 'second',
  time: '13:00',
  start: today + 'T12:00:00Z',
  end: today + 'T12:30:00Z',
};
const path = salon + '/appointments/' + visit.id;
const v = pl.visit;
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const visitRow = (page: Page, appointment: typeof visit) =>
  button(page, `${appointment.time} ${pl.day.walkIn} · ${appointment.service.name}`);
const networkError = (page: Page) => page.getByRole('alert').filter({ hasText: pl.error.network });

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(today + 'T08:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url());
    const day = url.searchParams.get('from');
    const replies: Record<string, unknown> = {
      '/v1/auth/refresh': { accessToken: 'test' },
      '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner' }] },
      '/v1/organizations/org/locations': [location],
      '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
      [salon + '/staff']: [],
      [salon + '/time-blocks']: [],
      [salon + '/calendar']: { from: day, location, staff: [], appointments: [visit, otherVisit] },
      [path]: visit,
      [salon + '/appointments/' + otherVisit.id]: otherVisit,
      [salon + '/availability']: {
        durationMinutes: 30,
        slots: [
          {
            date: day,
            time: day === today ? '14:00' : '15:00',
            start: day + (day === today ? 'T13:00:00Z' : 'T14:00:00Z'),
            staffIds: [visit.staff.id],
          },
        ],
      },
    };
    if (url.pathname.endsWith('/photos')) return route.fulfill({ json: { items: [] } });
    if (url.pathname.endsWith('/reservations'))
      return route.fulfill({ json: { reservations: [] } });
    if (url.pathname in replies) return route.fulfill({ json: replies[url.pathname] });
    return route.fulfill({ status: 404 });
  });
  await page.goto(app.url);
});

test('a block reason survives a failed save and a calendar round trip until saved or discarded', async ({
  page,
}) => {
  const open = button(page, '+ ' + pl.blocks.add);
  const reason = page.getByRole('textbox', { name: pl.blocks.reason });
  const note = 'Szkolenie zespołu';
  await open.click();
  await reason.fill(note);
  const endpoint = '**' + salon + '/time-blocks';
  await page.route(endpoint, (route) => route.abort(), { times: 1 });
  await button(page, pl.blocks.save).click();
  await expect(networkError(page)).toBeVisible();
  await expect(reason).toHaveValue(note);
  await button(page, pl.schedule.back).click();

  await button(page, pl.day.next).click();
  await open.click();
  await expect(reason).toHaveValue('');
  await button(page, pl.schedule.back).click();
  await button(page, pl.day.previous).click();
  await open.click();
  await expect(reason).toHaveValue(note);
  await expect(networkError(page)).toHaveCount(0);

  await page.route(endpoint, (route) => {
    const body = route.request().postDataJSON();
    expect(body.reason).toBe(note);
    return route.fulfill({ status: 201, json: { id: 'block', ...body } });
  });
  await button(page, pl.blocks.save).click();
  await expect(page.getByText(pl.blocks.added)).toBeVisible();
  await open.click();
  await expect(reason).toHaveValue('');
  await reason.fill('Przerwa');
  await button(page, pl.blocks.cancel).click();
  await open.click();
  await expect(reason).toHaveValue('');
});

test('a move restores the selected date and time only for its visit and resets after saving', async ({
  page,
}) => {
  const move = button(page, v.move);
  const confirmation = page.getByText(
    v.moveAsk.replace('{when}', dayTitle(tomorrow, 'pl') + ' 15:00'),
  );
  await visitRow(page, visit).click();
  await move.click();
  await button(page, v.nextDay).click();
  await button(page, '15:00').click();
  await expect(confirmation).toBeVisible();
  const endpoint = '**' + path + '/reschedule';
  await page.route(endpoint, (route) => route.abort(), { times: 1 });
  await button(page, v.yes).click();
  await expect(networkError(page)).toBeVisible();
  await expect(confirmation).toBeVisible();
  await button(page, v.back).click();

  await visitRow(page, otherVisit).click();
  await move.click();
  await expect(button(page, '14:00')).toBeVisible();
  await expect(button(page, v.previousDay)).toBeDisabled();
  await button(page, v.back).click();
  await visitRow(page, visit).click();
  await move.click();
  await expect(confirmation).toBeVisible();
  await expect(networkError(page)).toHaveCount(0);

  const start = tomorrow + 'T14:00:00Z';
  let release!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(endpoint, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ version: visit.version, start });
    await pendingSave;
    return route.fulfill({
      json: {
        ...visit,
        version: 2,
        date: tomorrow,
        time: '15:00',
        start,
        end: tomorrow + 'T14:30:00Z',
      },
    });
  });
  try {
    await Promise.all([page.waitForRequest(endpoint), button(page, v.yes).click()]);
    await expect(button(page, v.back)).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByText(v.moved)).toBeVisible();
  await expect(button(page, v.back)).toBeEnabled();
  await move.click();
  await expect(button(page, '15:00')).toBeVisible();
  await expect(confirmation).toHaveCount(0);
});

test('a cancellation reason stays with its visit across a disconnect and is discarded on close', async ({
  page,
}) => {
  const cancel = button(page, v.cancel);
  const reason = page.getByRole('textbox', { name: v.reason });
  const note = 'Zmiana planów klienta';
  await visitRow(page, visit).click();
  await cancel.click();
  await reason.fill(note);
  await cancel.click();
  const endpoint = '**' + path + '/cancel';
  await page.route(endpoint, (route) => route.abort(), { times: 1 });
  await button(page, v.cancelYes).click();
  await expect(networkError(page)).toBeVisible();
  await expect(reason).toHaveValue(note);
  await button(page, v.back).click();

  await visitRow(page, otherVisit).click();
  await cancel.click();
  await expect(reason).toHaveValue('');
  await reason.fill('Przypadkowy wpis');
  await button(page, v.close).click();
  await cancel.click();
  await expect(reason).toHaveValue('');
  await button(page, v.back).click();
  await visitRow(page, visit).click();
  await cancel.click();
  await expect(reason).toHaveValue(note);
  await expect(networkError(page)).toHaveCount(0);

  await page.route(endpoint, (route) => {
    expect(route.request().postDataJSON()).toEqual({ version: visit.version, reason: note });
    return route.fulfill({
      json: { ...visit, version: 2, status: 'cancelled', cancelReason: note },
    });
  });
  await cancel.click();
  await button(page, v.cancelYes).click();
  await expect(page.getByText(v.cancelled)).toBeVisible();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
});
