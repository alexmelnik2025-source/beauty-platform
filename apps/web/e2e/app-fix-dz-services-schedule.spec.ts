import { expect, test, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { openBusinessMenu, serveApp } from './mobile-app';

const base = '**/v1/organizations/dz/locations/centrum';
const staff = {
  id: 'anna',
  userId: 'owner',
  displayName: 'Anna',
  active: true,
  specialties: [],
  serviceIds: [],
  sortOrder: 0,
};
const service = {
  id: 'cut',
  name: 'Strzyżenie',
  active: true,
  staffIds: [staff.id],
  categoryId: null,
  durationMinutes: 30,
  priceGrosze: 8000,
};
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
let app: Awaited<ReturnType<typeof serveApp>>;

test.use({ viewport: { width: 320, height: 740 }, isMobile: true });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => app?.server.close());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'dz'));
  await page.route('**/v1/**', (route) => route.abort());
  await page.route('**/v1/auth/refresh', (route) =>
    route.fulfill({ json: { accessToken: 'dz-access', refreshToken: 'dz' } }),
  );
  await page.route('**/v1/me', (route) =>
    route.fulfill({
      json: { user: { id: 'owner' }, organizations: [{ id: 'dz', name: 'Studio', role: 'owner' }] },
    }),
  );
  await page.route('**/v1/organizations/dz/locations', (route) =>
    route.fulfill({
      json: [{ id: 'centrum', name: 'Centrum', city: 'Warszawa', currency: 'PLN' }],
    }),
  );
  await page.route(base + '/staff', (route) => route.fulfill({ json: [staff] }));
  await page.goto(app.url);
});

async function retryAfterOfflineOpen(
  page: Page,
  open: () => Promise<void>,
  replies: Record<string, unknown>,
) {
  await page.route(base + '/**', (route) => route.abort('internetdisconnected'));
  await open();
  const alert = page.getByRole('alert').first();
  await expect(alert).toHaveText(pl.error.network);
  const retry = button(page, pl.day.refresh);
  const label = retry.getByText(pl.day.refresh, { exact: true });
  const size = () => label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await size();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important; }' });
  expect(await size()).toBeCloseTo(normal * 1.3, 1);
  const reads: string[] = [];
  for (const [path, json] of Object.entries(replies)) {
    await page.route(base + path, (route) => {
      reads.push(path);
      return route.fulfill({ json });
    });
  }
  await retry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect(retry).toHaveCount(0);
  await expect.poll(() => [...reads].sort()).toEqual(Object.keys(replies).sort());
}

test('the price list reloads after opening services offline', async ({ page }) => {
  await retryAfterOfflineOpen(page, () => openBusinessMenu(page, pl.services.open), {
    '/staff': [staff],
    '/services': [service],
    '/service-categories': [],
    '/staff-prices': { prices: [], durations: [] },
  });
  await expect(page.getByText(service.name, { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('promotions reload rules and their staff and service names after opening offline', async ({
  page,
}) => {
  await retryAfterOfflineOpen(page, () => openBusinessMenu(page, pl.happyHours.open), {
    '/staff': [staff],
    '/services': [service],
    '/happy-hours': {
      rules: [
        {
          id: 'offer',
          kind: 'lastMinute',
          lastMinuteHours: 4,
          discountPercent: 10,
          weekdays: [],
          start: null,
          end: null,
          staffIds: [staff.id],
          serviceIds: [service.id],
        },
      ],
    },
  });
  await expect(page.getByText('−10%', { exact: true })).toBeVisible();
  await expect(page.getByText(pl.happyHours.staff + ': ' + staff.displayName)).toBeVisible();
  await expect(page.getByText(pl.happyHours.services + ': ' + service.name)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a specialist’s schedule and profile both recover after opening offline', async ({ page }) => {
  await openBusinessMenu(page, pl.schedule.teamOpen);
  const member = button(page, staff.displayName);
  await expect(member).toBeVisible();
  await retryAfterOfflineOpen(page, () => member.click(), {
    '/staff': [staff],
    '/services': [service],
    '/staff/anna/working-hours': {
      timezone: 'Europe/Warsaw',
      weekly: [{ weekday: 1, intervals: [{ start: '09:00', end: '17:00' }] }],
      overrides: [],
    },
    '/staff/anna/time-off': [],
  });
  await expect(page.getByText('09:00–17:00', { exact: true })).toBeVisible();
  await expect(page.getByText(pl.schedule.noTimeOff)).toBeVisible();
  await expect(button(page, pl.staffProfile.edit)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
