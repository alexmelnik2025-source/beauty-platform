import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const salon = {
  slug: 'salon-eb',
  name: 'Studio EB',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  addressLine: 'Jasna 1',
  postalCode: '00-001',
  city: 'Warszawa',
  phone: null,
  languages: [],
  todayHours: { date: '2026-11-26', intervals: [] },
  openingHours: [],
  photos: [],
  categories: [],
};
const detail = '**/v1/public/locations/' + salon.slug;

let app: Awaited<ReturnType<typeof serveApp>>;
test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl' });
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => app?.server.close());

const reply = (page: Page, path: string, json: unknown) =>
  page.route(path, (route) => route.fulfill({ json }));

async function expectTouchTarget(control: Locator) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

test('reselecting a review filter preserves loaded pages and opening the voucher moves focus to its code', async ({
  page,
}) => {
  await reply(page, detail, { ...salon, services: [], staff: [] });
  await reply(page, detail + '/free-today', { staffIds: [] });
  let releaseMore!: () => void;
  const moreHeld = new Promise<void>((resolve) => {
    releaseMore = resolve;
  });
  let releaseFour!: () => void;
  const fourHeld = new Promise<void>((resolve) => {
    releaseFour = resolve;
  });
  const queries: string[] = [];
  await page.route(detail + '/reviews*', async (route) => {
    const query = new URL(route.request().url()).search;
    queries.push(query);
    if (query.startsWith('?before=')) await moreHeld;
    if (query === '?rating=4') await fourHeld;
    const first = !query;
    return route.fulfill({
      json: {
        enabled: true,
        count: 2,
        average: 4.5,
        stars: [0, 0, 0, 1, 1],
        staff: [],
        items: [
          {
            id: first ? 'one' : 'two',
            rating: first ? 5 : 4,
            text: first ? 'Pierwsza opinia' : 'Kolejna opinia',
            createdAt: '2026-11-24T10:00:00Z',
            staffName: 'Ewa',
            serviceName: 'Cięcie',
          },
        ],
        nextBefore: first ? 'one' : null,
      },
    });
  });
  await page.goto(app.url + '/pl/b/' + salon.slug);
  const reviews = page.getByRole('region', { name: t.salonReviews.title });
  await reviews.getByRole('button', { name: t.salonReviews.more }).click();
  await expect.poll(() => queries).toEqual(['', '?before=one']);
  const all = reviews.getByRole('radio', { name: t.salonReviews.allStars });
  await expectTouchTarget(all);
  await expect(all).toBeChecked();
  await all.click();
  releaseMore();
  await expect(reviews.getByText('Kolejna opinia')).toBeVisible();
  await all.click();
  await expect(reviews.getByText('Kolejna opinia')).toBeVisible();
  const four = reviews.getByRole('radio', { name: '★ 4 (1)' });
  await four.click();
  await expect.poll(() => queries).toContain('?rating=4');
  await expect(reviews.getByRole('progressbar')).toBeVisible();
  await all.click();
  await expect(reviews.getByRole('progressbar')).toHaveCount(0);
  await expect(reviews.getByText('Kolejna opinia')).toBeVisible();
  await four.click();
  await expect(reviews.getByRole('progressbar')).toBeVisible();
  releaseFour();
  await expect(four).toBeChecked();
  await four.click();
  const open = page.getByRole('button', { name: t.voucherCheck.open });
  await open.focus();
  await open.press('Enter');
  const code = page.getByRole('textbox', { name: t.voucherCheck.code, exact: true });
  await expect(code).toBeFocused();
  await expectTouchTarget(code);
  expect(queries).toEqual(['', '?before=one', '?rating=4']);
});

test('a confirmed waitlist day does not submit twice and a second day can still be joined', async ({
  page,
}) => {
  const serviceId = '00000000-0000-4000-8000-000000000001';
  const staffId = '00000000-0000-4000-8000-000000000002';
  await page.clock.setFixedTime(new Date('2026-11-26T10:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await reply(page, '**/v1/client/me', { email: 'anna@example.test', locale: 'pl' });
  let listReads = 0;
  await page.route('**/v1/client/waitlist', (route) => {
    listReads++;
    return route.fulfill({ json: { items: [] } });
  });
  await reply(page, '**/v1/client/appointments?scope=*', { items: [] });
  await reply(page, detail, {
    ...salon,
    services: [
      {
        id: serviceId,
        name: 'Cięcie',
        durationMinutes: 30,
        priceFromGrosze: 7000,
        priceToGrosze: 7000,
      },
    ],
    staff: [
      {
        id: staffId,
        displayName: 'Ewa',
        serviceIds: [serviceId],
        languages: [],
        specialties: [],
        prices: [],
      },
    ],
  });
  await reply(page, detail + '/availability?*', { slots: [] });
  const joinPath = '**/v1/client/waitlist/locations/' + salon.slug;
  let releaseThird!: () => void;
  const thirdHeld = new Promise<void>((resolve) => {
    releaseThird = resolve;
  });
  const joinedDates: string[] = [];
  await page.route(joinPath, async (route) => {
    const date = route.request().postDataJSON().date as string;
    const alreadyWaiting = date === '2026-11-28' || joinedDates.includes(date);
    joinedDates.push(date);
    if (date === '2026-11-28') await thirdHeld;
    return route.fulfill({ json: { alreadyWaiting } });
  });
  await page.goto(app.url + '/pl/b/' + salon.slug + '?service=' + serviceId + '&staff=' + staffId);
  await page.getByRole('button', { name: t.waitlist.open }).click();
  const name = page.getByRole('textbox', { name: t.book.name, exact: true });
  await expect(name).toBeFocused();
  await name.fill('Anna');
  const days = page.getByRole('button', { name: new RegExp('^' + t.waitlist.wait + ':') });
  const first = days.first();
  await expectTouchTarget(first);
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await first.click();
  const second = days.nth(1);
  await second.click();
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await first.click();
  await expect(page.getByRole('status').filter({ hasText: 'Zapisano na listę' })).toContainText(
    '26',
  );
  expect(joinedDates).toEqual(['2026-11-26', '2026-11-27']);

  await days.nth(2).click();
  await expect.poll(() => joinedDates.at(-1)).toBe('2026-11-28');
  await page.getByRole('button', { name: t.book.back, exact: true }).click();
  await expect(page.getByText(t.visits.emptyUpcoming, { exact: true })).toBeVisible();
  const readsBeforeConfirmation = listReads;
  const confirmation = page.waitForResponse(joinPath);
  releaseThird();
  await (await confirmation).finished();
  await page.waitForLoadState('networkidle');
  expect(listReads).toBe(readsBeforeConfirmation);
});
