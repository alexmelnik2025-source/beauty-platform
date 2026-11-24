import { expect, test, type Page, type Route } from '@playwright/test';
import { addDays, todayIn } from '../../mobile-client/src/api';
import { formatDay } from '../../mobile-client/src/format';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const base = '**/v1/public/locations/studio-bz';
const service = 'Strzyżenie';
const salon = {
  slug: 'studio-bz',
  name: 'Studio BZ',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  categories: [],
  services: [
    {
      id: 'cut',
      name: service,
      durationMinutes: 30,
      priceGrosze: 9000,
      priceFromGrosze: 9000,
      priceToGrosze: 9000,
    },
  ],
  staff: ['Kasia', 'Marek'].map((displayName) => ({
    id: displayName,
    displayName,
    serviceIds: ['cut'],
    prices: [],
    specialties: [],
    languages: [],
    reviewCount: 0,
    rating: null,
  })),
};

test.use({ viewport: { width: 320, height: 700 }, isMobile: true, locale: 'pl-PL' });
let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => {
  app?.server.close();
});

async function openServices(page: Page) {
  let loads = 0;
  await page.route(base, (route) => {
    loads++;
    return route.fulfill({ json: salon });
  });
  await page.goto(app.url + '/pl/b/studio-bz?service=00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('heading', { name: t.book.pickService, exact: true })).toBeVisible();
  return () => loads;
}

function slot(date: string, time: string, staff = 'Kasia') {
  return { date, time, start: date + 'T' + time + ':00Z', staffIds: [staff], discountPercent: 20 };
}

test('a newer day or specialist wins, and returning reuses days and services', async ({ page }) => {
  const loads = await openServices(page);
  const today = todayIn(salon.timezone);
  const tomorrow = addDays(today, 1);
  const calls: string[] = [];
  const delayed: Route[] = [];
  await page.route(base + '/availability?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const from = params.get('from')!;
    const to = params.get('to')!;
    const staff = params.get('staffId');
    calls.push(route.request().url());
    if (calls.length <= 2 || staff === 'Kasia') {
      delayed.push(route);
      return;
    }
    const slots =
      staff === 'Marek'
        ? [slot(tomorrow, '16:00', staff)]
        : [slot(today, '09:00'), slot(tomorrow, '14:00')];
    await route.fulfill({ json: { slots: slots.filter((s) => s.date >= from && s.date <= to) } });
  });
  const button = (name: string | RegExp) => page.getByRole('button', { name, exact: true });
  const row = button(/^Umów: /);
  await row.click();
  await expect.poll(() => delayed.length).toBe(1);
  await button(formatDay(today, 'pl')).click();
  await expect.poll(() => delayed.length).toBe(2);
  await delayed[0]!.fulfill({ json: { slots: [] } });
  const first = delayed[1]!;
  const firstDay = new URL(first.request().url()).searchParams;
  expect([firstDay.get('from'), firstDay.get('to')]).toEqual([today, today]);
  const canceled = page.waitForEvent('requestfailed', (r) => r === first.request());
  await button(formatDay(tomorrow, 'pl')).click();
  await expect(button(/^14:00/)).toBeVisible();
  await first.fulfill({ json: { slots: [slot(today, '08:00')] } });
  await canceled;
  await expect(button(formatDay(tomorrow, 'pl'))).toHaveAttribute('aria-pressed', 'true');
  await expect(button(/^08:00/)).toHaveCount(0);

  // The waitlist appears once the complete range (including empty days) is known.
  await expect(button(t.waitlist.open)).toBeVisible();
  const afterLoad = calls.length;
  await button(formatDay(today, 'pl')).click();
  await expect(button(/^09:00/)).toBeVisible();
  await button(formatDay(tomorrow, 'pl')).click();
  await expect(button(/^14:00/)).toBeVisible();
  expect(calls).toHaveLength(afterLoad);

  await button('Kasia').click();
  await expect.poll(() => delayed.length).toBe(3);
  const stale = delayed[2]!;
  const canceledStaff = page.waitForEvent('requestfailed', (r) => r === stale.request());
  await button('Marek').click();
  await expect(button(/^16:00/)).toBeVisible();
  await stale.fulfill({ json: { slots: [slot(tomorrow, '11:00')] } });
  await canceledStaff;
  await expect(button(/^11:00/)).toHaveCount(0);
  await expect(button(t.waitlist.open)).toBeVisible();
  const afterStaff = calls.length;
  await button(t.book.back).click();
  await row.click();
  await expect(button(/^14:00/)).toBeVisible();
  expect(calls).toHaveLength(afterStaff);
  expect(loads()).toBe(1);
});

test('a failed day can be retried and rapid confirmation sends one request', async ({ page }) => {
  await openServices(page);
  const date = addDays(todayIn(salon.timezone), 1);
  const time = '14:00';
  await page.route(base + '/availability?*', (route) =>
    route.fulfill({ json: { slots: [slot(date, time)] } }),
  );
  await page.route(base + '/availability?*', (route) => route.abort('connectionreset'), {
    times: 1,
  });
  await page.route(base + '/holds', (route) =>
    route.fulfill({
      json: {
        holdId: 'hold-bz',
        holdToken: 'test',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        date,
        time,
        serviceName: service,
        staffName: 'Kasia',
        currency: 'PLN',
        priceGrosze: 7200,
        listPriceGrosze: 9000,
        happyHourPercent: 20,
      },
    }),
  );
  const hold = '**/v1/public/holds/hold-bz';
  await page.route(hold + '/code', (route) => route.fulfill({ status: 204 }));
  const submissions: Route[] = [];
  await page.route(hold + '/confirm', (route) => {
    submissions.push(route);
  });

  const button = (name: string | RegExp) => page.getByRole('button', { name, exact: true });
  await button(/^Umów: /).click();
  await expect(page.getByRole('alert')).toContainText(t.error.network);
  await button(t.retry).click();
  await button(/^14:00/).click();
  await page.getByLabel(t.book.name, { exact: true }).fill('Ola Nowak');
  await page.getByLabel(t.book.phone, { exact: true }).fill('600 300 400');
  await page.getByRole('textbox', { name: t.book.email, exact: true }).fill('ola@example.com');
  await page.getByRole('checkbox', { name: t.book.acceptTerms }).click();
  await button(t.book.sendCode).click();
  await page.getByLabel(t.book.codeTitle, { exact: true }).fill('246810');

  const confirm = button(t.book.confirm);
  // Dispatch both presses in the same JS turn, before React can disable the control.
  await confirm.evaluate((element) => {
    (element as HTMLElement).click();
    (element as HTMLElement).click();
  });
  await expect(confirm).toBeDisabled();
  await expect.poll(() => submissions.length).toBe(1);
  await submissions[0]!.fulfill({
    json: {
      manageToken: 'test',
      appointment: { date, time, service: { name: service }, staff: { displayName: 'Kasia' } },
    },
  });
  await expect(page.getByRole('heading', { name: t.book.doneTitle })).toBeVisible();
  expect(submissions).toHaveLength(1);
});
