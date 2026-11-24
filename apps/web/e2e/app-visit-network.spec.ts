import { expect, test, type Locator, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

const v = pl.visit;
const date = '2026-11-24';
const nextDate = '2026-11-25';
const path = '/v1/organizations/org/locations/salon/appointments/visit';
const visit = {
  id: 'visit',
  version: 1,
  date,
  time: '12:00',
  start: date + 'T11:00:00Z',
  end: date + 'T11:30:00Z',
  status: 'confirmed',
  awaitingApproval: true,
  service: { id: 'service', name: 'Strzyżenie' },
  staff: { id: 'anna', displayName: 'Anna' },
  customer: null,
  priceGrosze: 8000,
  durationMinutes: 30,
  paidAt: null,
  tipGrosze: 0,
};

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test.beforeEach(async ({ page }) => {
  const location = { id: 'salon', name: 'Salon CJ', timezone: 'Europe/Warsaw', currency: 'PLN' };
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  await page.clock.setFixedTime(new Date(date + 'T08:00:00Z'));
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url());
    const replies: Record<string, unknown> = {
      '/v1/auth/refresh': { accessToken: 'test' },
      '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner' }] },
      '/v1/organizations/org/locations': [location],
      '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
      '/v1/organizations/org/locations/salon/staff': [],
      '/v1/organizations/org/locations/salon/calendar': {
        from: date,
        location,
        staff: [],
        appointments: [visit],
      },
      [path]: visit,
      [path + '/photos']: { items: [] },
      [path + '/reservations']: { reservations: [] },
    };
    if (!(url.pathname in replies)) return route.fulfill({ status: 404 });
    return route.fulfill({ json: replies[url.pathname] });
  });
});

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const networkError = (page: Page) => page.getByRole('alert').filter({ hasText: pl.error.network });

async function openVisit(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: /Klient bez karty · Strzyżenie/ }).click();
}

// Hold the first response until both taps have been delivered, then drop it.
// The explicit retry must submit exactly the same payload as the first attempt.
async function doubleTapWithDisconnect(
  page: Page,
  control: Locator,
  endpoint: string,
  updated: object,
  payload: object,
) {
  const requests: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**' + path + '/' + endpoint, async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await gate;
      return route.abort();
    }
    return route.fulfill({ json: updated });
  });
  try {
    await control.evaluate((el: HTMLElement) => {
      el.click();
      el.click();
    });
    await expect(control).toBeDisabled();
    await expect.poll(() => requests.length).toBe(1);
  } finally {
    release();
  }
  await expect(networkError(page)).toBeVisible();
  await expect(control).toBeEnabled();
  const alertBox = (await networkError(page).boundingBox())!;
  const buttonBox = (await control.boundingBox())!;
  const gap = Math.max(
    alertBox.y - buttonBox.y - buttonBox.height,
    buttonBox.y - alertBox.y - alertBox.height,
  );
  expect(gap, 'network error next to the action').toBeLessThan(100);
  return async () => {
    await control.click();
    await expect(networkError(page)).toHaveCount(0);
    await expect.poll(() => requests).toEqual([payload, payload]);
  };
}

test('approve, move and cancel once, retaining the selected day and reason after a disconnect', async ({
  page,
}) => {
  const app = await serveApp('mobile-business');
  const approved = { ...visit, awaitingApproval: false, version: 2 };
  const moved = {
    ...approved,
    date: nextDate,
    start: nextDate + 'T11:00:00Z',
    end: nextDate + 'T11:30:00Z',
    version: 3,
  };
  try {
    await openVisit(page, app.url);
    const approve = button(page, v.approve);
    const retryApprove = await doubleTapWithDisconnect(page, approve, 'approve', approved, {
      version: 1,
    });
    await retryApprove();
    await expect(approve).toHaveCount(0);

    await page.route('**/availability?*', (route) => {
      const day = new URL(route.request().url()).searchParams.get('from');
      return route.fulfill({
        json: {
          slots: [{ date: day, time: '12:00', start: day + 'T11:00:00Z', staffIds: ['anna'] }],
        },
      });
    });
    await button(page, v.move).click();
    await expect(button(page, '12:00')).toBeVisible();
    await page.route('**/availability?*', (route) => route.abort(), { times: 1 });
    await button(page, v.nextDay).click();
    await expect(networkError(page)).toBeVisible();
    await button(page, pl.day.refresh).click();
    await button(page, '12:00').click();
    const question = page.getByText(/Przenieść na .*25.*12:00\?/);
    await expect(question).toBeVisible();
    const retryMove = await doubleTapWithDisconnect(
      page,
      button(page, v.yes),
      'reschedule',
      moved,
      { version: 2, start: moved.start },
    );
    await expect(question).toBeVisible();
    await retryMove();
    await expect(page.getByText(v.moved)).toBeVisible();

    await button(page, v.cancel).click();
    const reason = page.getByRole('textbox', { name: v.reason });
    await reason.fill('Na prośbę klienta');
    await button(page, v.cancel).click();
    const retryCancel = await doubleTapWithDisconnect(
      page,
      button(page, v.cancelYes),
      'cancel',
      { ...moved, status: 'cancelled', cancelReason: 'Na prośbę klienta', version: 4 },
      { version: 3, reason: 'Na prośbę klienta' },
    );
    await expect(reason).toHaveValue('Na prośbę klienta');
    await retryCancel();
    await expect(page.getByText(v.status.cancelled, { exact: true })).toBeVisible();
  } finally {
    app.server.close();
  }
});

test('attendance, payment and tip survive a dropped request and can be retried once', async ({
  page,
}) => {
  const app = await serveApp('mobile-business');
  await page.clock.setFixedTime(new Date(date + 'T14:00:00Z'));
  const completed = { ...visit, awaitingApproval: false, status: 'completed', version: 2 };
  const paid = { ...completed, paidAt: date + 'T14:00:00Z', paymentMethod: 'card', version: 3 };
  try {
    await openVisit(page, app.url);
    const retryStatus = await doubleTapWithDisconnect(
      page,
      button(page, v.markCame),
      'status',
      completed,
      { version: 1, status: 'completed' },
    );
    await retryStatus();
    await expect(page.getByText(v.status.completed)).toBeVisible();

    const card = page.getByRole('radio', { name: v.paymentMethods.card });
    await card.click();
    const retryPay = await doubleTapWithDisconnect(
      page,
      button(page, v.markPaid),
      'payment',
      paid,
      { version: 2, paid: true, method: 'card' },
    );
    await expect(card).toBeChecked();
    await retryPay();
    await expect(button(page, v.unmarkPaid)).toBeVisible();

    const tip = page.getByTestId('tip-field').getByRole('textbox');
    await tip.fill('12,5');
    const retryTip = await doubleTapWithDisconnect(
      page,
      button(page, v.tipSave),
      'tip',
      { ...paid, version: 4, tipGrosze: 1250 },
      { version: 3, tipGrosze: 1250 },
    );
    await expect(page.getByTestId('tip-field').getByRole('alert')).toHaveText(pl.error.network);
    await expect(tip).toHaveValue('12,5');
    await retryTip();
    await expect(tip).toHaveValue('12,50');
    await expect(button(page, v.tipSave)).toBeDisabled();
  } finally {
    app.server.close();
  }
});

test('photo retry and failed conflict refresh preserve the open visit', async ({ page }) => {
  const app = await serveApp('mobile-business');
  const photo = { id: 'photo', url: '/visit-photo.png' };
  await page.route('**' + path + '/photos', (route) => route.fulfill({ json: { items: [photo] } }));
  await page.route('**' + path + '/photos', (route) => route.abort(), { times: 1 });
  await page.route('**/visit-photo.png', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    }),
  );
  await page.route('**/visit-photo.png', (route) => route.abort(), { times: 1 });
  try {
    await openVisit(page, app.url);
    const header = page.getByRole('heading', { name: '12:00–12:30' });
    await expect(header).toBeVisible();
    await expect(page.getByText(v.photos, { exact: false })).toBeVisible();
    await expect(networkError(page)).toBeVisible();
    await button(page, pl.day.refresh).click();
    await button(page, pl.day.refresh + ': Zdjęcie od klienta 1').click();
    await expect(page.getByRole('link', { name: 'Zdjęcie od klienta 1' })).toBeVisible();
    await expect(networkError(page)).toHaveCount(0);

    await page.route('**' + path + '/approve', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT' } } }),
    );
    await page.route('**' + path, (route) =>
      route.fulfill({ json: { ...visit, awaitingApproval: false, version: 2 } }),
    );
    await page.route('**' + path, (route) => route.abort(), { times: 1 });
    await button(page, v.approve).click();
    await expect(networkError(page)).toBeVisible();
    await expect(header).toBeVisible();
    await expect(page.getByText(visit.staff.displayName, { exact: true })).toBeVisible();
    await button(page, pl.day.refresh).click();
    await expect(button(page, v.approve)).toHaveCount(0);
    await expect(networkError(page)).toHaveCount(0);
    await expect(header).toBeVisible();
    await expect(page.getByText(v.conflict)).toBeVisible();
  } finally {
    app.server.close();
  }
});
