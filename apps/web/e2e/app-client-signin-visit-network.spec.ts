import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';
import type { ClientAppointment, Slot } from '../../mobile-client/src/api';
import { DICTIONARIES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const email = 'anna@example.com';
const salon = {
  slug: 'studio',
  name: 'Studio CB',
  addressLine: 'Prosta 1',
  city: 'Warszawa',
  postalCode: '00-001',
  phone: null,
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};
const service = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Strzyżenie',
  durationMinutes: 30,
  priceGrosze: 7000,
};
const staff = { id: '00000000-0000-4000-8000-000000000002', displayName: 'Ola' };
const visit: ClientAppointment = {
  id: 'visit',
  salon,
  service,
  staff,
  timezone: salon.timezone,
  currency: salon.currency,
  status: 'confirmed',
  date: '2026-12-02',
  time: '10:00',
  start: '2026-12-02T09:00:00Z',
  end: '2026-12-02T09:30:00Z',
  changeableUntil: '2026-12-01T09:00:00Z',
  canChange: true,
  wishQuestions: { mood: false, drinks: [], note: false },
  wishes: { mood: null, drink: null, note: null },
  coupons: [],
  discountGrosze: 0,
  awaitingApproval: false,
  bookAgain: null,
  canChangeWishes: false,
};
const slot: Slot = {
  date: '2026-12-03',
  time: '11:00',
  start: '2026-12-03T10:00:00Z',
  staffIds: [staff.id],
  discountPercent: null,
};
const base = '**/v1/client/appointments/visit';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-client');
});
test.afterAll(() => {
  app?.server.close();
});

function reply(page: Page, path: string, json: unknown) {
  return page.route(path, (route) => route.fulfill({ json }));
}

async function restoreSession(page: Page) {
  await page.clock.setFixedTime(new Date('2026-11-24T10:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'e2e-client'));
  await reply(page, '**/v1/client/me', { email, locale: 'pl' });
  await reply(page, '**/v1/client/waitlist', { items: [] });
}

async function openVisit(page: Page, completed = false) {
  await restoreSession(page);
  const detail = completed
    ? {
        ...visit,
        status: 'completed',
        canChange: false,
        date: '2026-11-23',
        start: '2026-11-23T09:00:00Z',
        end: '2026-11-23T09:30:00Z',
      }
    : visit;
  await reply(page, '**/v1/client/appointments?scope=upcoming', {
    items: completed ? [] : [detail],
  });
  await reply(page, '**/v1/client/appointments?scope=past', { items: completed ? [detail] : [] });
  await reply(page, '**/v1/client/me/summary', { completed: 1, salons: 1, spent: [] });
  await reply(page, base, detail);
  await reply(page, base + '/coupons', { applied: [], available: [] });
  await reply(page, base + '/photos', { items: [] });
  await reply(page, base + '/products', { available: [], reservations: [], totalGrosze: 0 });
  await reply(page, base + '/products/used', { products: [] });
  await reply(page, base + '/review', { canReview: true, review: null });
  await page.goto(app.url);
  if (completed) await page.getByRole('tab', { name: 'Historia' }).click();
  await page
    .getByRole('button', { name: new RegExp(service.name + ', ' + salon.name + '$') })
    .click();
}

// Hold the first response until the pending UI has been checked, then drop it.
// Count writes across the two taps and the explicit retry, even when they share a key.
async function checkRetry(
  page: Page,
  path: string,
  button: Locator,
  region: Page | Locator,
  success: unknown,
  checkDraft: () => Promise<void>,
) {
  const writes: Request[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    writes.push(route.request());
    if (writes.length === 1) {
      await pending;
      await route.abort('connectionreset');
    } else {
      await route.fulfill({ json: success });
    }
  };
  await page.route(path, handler);
  try {
    await expect(button).toBeEnabled();
    await button.evaluate((node: HTMLElement) => {
      node.click();
      node.click();
    });
    await expect(button).toBeDisabled();
    await expect.poll(() => writes.length).toBe(1);
    release();
    await expect(region.getByRole('alert')).toHaveText(t.error.network);
    await checkDraft();
    await region.getByRole('button', { name: t.retry, exact: true }).click();
    await expect(region.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]!.postDataJSON()).toEqual(writes[0]!.postDataJSON());
    return writes;
  } finally {
    release();
    await page.unroute(path, handler);
  }
}

test('send and resend keep the sign-in fields after a dropped request', async ({ page }) => {
  await reply(page, '**/v1/public/locations?*', { openNowCount: 0 });
  await page.goto(app.url);
  const address = page.getByRole('textbox', { name: t.signIn.email });
  const code = page.getByRole('textbox', { name: t.signIn.code });
  const path = '**/v1/client/auth/code';
  await address.fill(email);
  await checkRetry(
    page,
    path,
    page.getByRole('button', { name: t.signIn.sendCode, exact: true }),
    page,
    { sent: true },
    () => expect(address).toHaveValue(email),
  );
  await code.fill('123456');
  const resend = await checkRetry(
    page,
    path,
    page.getByRole('button', { name: t.signIn.resend }),
    page,
    { sent: true },
    () => expect(code).toHaveValue('123456'),
  );
  expect(resend[1]!.postDataJSON()).toEqual({ email, locale: 'pl' });
  await expect(code).toHaveValue('');
});

test('move and cancel retry the same confirmed action', async ({ page }) => {
  const moved = { ...visit, ...slot, end: '2026-12-03T10:30:00Z' };
  const availability = '**/v1/public/locations/studio/availability?*';
  await reply(page, availability, { slots: [slot] });
  await page.route(availability, (route) => route.abort('connectionreset'), { times: 1 });
  await openVisit(page);
  for (const action of [
    {
      name: t.visit.move,
      yes: t.visit.moveYes,
      endpoint: 'reschedule',
      result: moved,
      done: t.visit.moved,
    },
    {
      name: t.visit.cancel,
      yes: t.visit.cancelYes,
      endpoint: 'cancel',
      result: { ...moved, status: 'cancelled', canChange: false },
      done: t.visit.cancelled,
    },
  ]) {
    await page.getByRole('button', { name: action.name, exact: true }).click();
    if (action.endpoint === 'reschedule') {
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await page.getByRole('button', { name: t.retry }).click();
      await page.getByRole('button', { name: slot.time }).click();
    }
    const dialog = page.getByRole('alertdialog', { name: action.name });
    const writes = await checkRetry(
      page,
      base + '/' + action.endpoint,
      dialog.getByRole('button', { name: action.yes }),
      dialog,
      action.result,
      () => expect(dialog).toContainText(slot.time),
    );
    const key = writes[0]!.headers()['idempotency-key'];
    expect(key).toBeTruthy();
    expect(writes[1]!.headers()['idempotency-key']).toBe(key);
    await expect(page.getByRole('status').filter({ hasText: action.done })).toBeVisible();
  }
});

test('review keeps the selected stars and text until the retry succeeds', async ({ page }) => {
  await openVisit(page, true);
  const review = page.getByRole('region', { name: t.review.title });
  const stars = review.getByRole('radio', { name: '4 z 5' });
  const text = review.getByRole('textbox', { name: t.review.text });
  const words = 'Dziękuję za strzyżenie!';
  await stars.click();
  await text.fill(words);
  const writes = await checkRetry(
    page,
    base + '/review',
    review.getByRole('button', { name: t.review.send }),
    review,
    { canReview: true, review: { rating: 4, text: words } },
    async () => {
      await expect(stars).toBeChecked();
      await expect(text).toHaveValue(words);
    },
  );
  expect(writes[1]!.postDataJSON()).toEqual({ rating: 4, text: words });
  await expect(review.getByRole('status')).toHaveText(t.review.thanks);
});

test('automatic waitlist keeps the phone and chosen day for retry', async ({ page }) => {
  await restoreSession(page);
  await reply(page, '**/v1/public/locations/studio', {
    ...salon,
    categories: [],
    services: [{ ...service, priceFromGrosze: 7000, priceToGrosze: 7000 }],
    staff: [{ ...staff, serviceIds: [service.id], languages: [], specialties: [], prices: [] }],
  });
  await reply(page, '**/v1/public/locations/studio/availability?*', { slots: [] });
  await reply(page, '**/v1/client/appointments?scope=*', { items: [] });
  await reply(page, '**/v1/public/locations?*', { items: [], total: 0, openNowCount: 0 });
  await page.goto(`${app.url}/pl/b/studio?service=${service.id}&staff=${staff.id}`);
  await page.getByRole('button', { name: t.waitlist.open }).click();
  await page.getByLabel(t.book.name, { exact: true }).fill('Anna');
  const auto = page.getByRole('switch', { name: t.waitlist.autoBook });
  await auto.check();
  const phone = page.getByRole('textbox', { name: t.book.phone });
  await phone.fill('600 111 023');
  const days = page.getByRole('button', { name: new RegExp('^' + t.waitlist.wait + ':') });
  const writes = await checkRetry(
    page,
    '**/v1/client/waitlist/locations/studio',
    days.first(),
    page,
    { alreadyWaiting: false },
    async () => {
      await expect(auto).toBeChecked();
      await expect(phone).toHaveValue('600 111 023');
    },
  );
  expect(writes[1]!.postDataJSON()).toMatchObject({ phone: '+48600111023', autoBook: true });
  await expect(days.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('status').filter({ hasText: 'Zapisano na listę oczekujących' }),
  ).toBeVisible();
});
