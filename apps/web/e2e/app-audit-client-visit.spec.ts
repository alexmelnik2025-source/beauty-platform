import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { ClientAppointment, Slot } from '../../mobile-client/src/api';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { auditLocales, enlargeText, expectFits } from './app-audit-client-fixture';
import { serveApp } from './mobile-app';

const visit: ClientAppointment = {
  id: 'audit-visit',
  salon: {
    slug: 'audit-studio',
    name: 'Studio DQ',
    addressLine: 'Prosta 1',
    city: 'Warszawa',
    postalCode: '00-001',
    phone: null,
  },
  service: { id: 'cut', name: 'Studio Classic', durationMinutes: 45, priceGrosze: 8000 },
  staff: { id: 'ola', displayName: 'Ola' },
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  status: 'confirmed',
  date: '2026-12-03',
  time: '10:00',
  start: '2026-12-03T09:00:00Z',
  end: '2026-12-03T09:45:00Z',
  changeableUntil: '2026-12-02T09:00:00Z',
  canChange: true,
  awaitingApproval: false,
  wishQuestions: { mood: true, drinks: ['tea'], note: true },
  canChangeWishes: true,
  wishes: { mood: null, drink: null, note: 'List snapshot' },
  bookAgain: { slug: 'audit-studio', serviceId: 'cut', staffId: 'ola' },
  coupons: [],
  discountGrosze: 0,
};
const slot: Slot = {
  date: '2026-12-04',
  time: '11:00',
  start: '2026-12-04T10:00:00Z',
  staffIds: ['ola'],
  discountPercent: null,
};
const emptyProducts = {
  canChange: false,
  currency: 'PLN',
  available: [],
  reservations: [],
  totalGrosze: 0,
};
const base = '**/v1/client/appointments/audit-visit';
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

async function holdRequests(page: Page, path: string) {
  const requests: Route[] = [];
  await page.route(path, (route) => {
    requests.push(route);
  });
  return requests;
}

async function doublePress(button: Locator) {
  await expect(button).toBeEnabled();
  await button.evaluate((element: HTMLElement) => {
    element.click();
    element.click();
  });
}

async function prepare(page: Page, locale: (typeof auditLocales)[number], item = visit) {
  await page.clock.setFixedTime(new Date('2026-11-26T11:40:00Z'));
  await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'audit-test'));
  await reply(page, '**/v1/client/me', { email: 'audit@example.test', locale });
  await reply(page, '**/v1/client/me/summary', {
    completed: 0,
    salons: 0,
    firstVisitAt: null,
    spent: [],
  });
  await reply(page, '**/v1/client/waitlist', { items: [] });
  const past = item.status !== 'confirmed';
  await reply(page, '**/v1/client/appointments?scope=upcoming', { items: past ? [] : [item] });
  await reply(page, '**/v1/client/appointments?scope=past', { items: past ? [item] : [] });
  await reply(page, base, item);
  await reply(page, base + '/photos', { items: [], deleteAfter: null });
  await reply(page, base + '/coupons', { applied: [], available: [], tier: null });
  await reply(page, base + '/products', emptyProducts);
  await page.goto(app.url);
  const t = DICTIONARIES[locale];
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await enlargeText(page.getByRole('heading', { name: t.visits.title, exact: true }));
  if (past) await page.getByRole('tab', { name: t.visits.past, exact: true }).click();
  return page.getByRole('button', {
    name: item.time + ' ' + item.service.name + ', ' + item.salon.name,
    exact: true,
  });
}

for (const locale of auditLocales) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
    const t = DICTIONARIES[locale];
    const button = (panel: Page | Locator, name: string) =>
      panel.getByRole('button', { name, exact: true });

    test('late visit details update untouched wishes and preserve typing', async ({ page }) => {
      const open = await prepare(page, locale);
      const details = await holdRequests(page, base);
      await open.click();
      const note = page.getByRole('textbox', { name: t.wishStep.noteQ });
      await expect(note).toHaveValue(visit.wishes.note!);
      await note.fill('My new note');
      const mood = button(page, '🤫 ' + t.wishStep.mood.quiet);
      await expect.poll(() => details.length).toBe(1);
      await details[0]!.fulfill({
        json: { ...visit, wishes: { mood: 'quiet', drink: 'tea', note: 'Updated elsewhere' } },
      });
      await expect(note).toHaveValue('My new note');
      await expect(mood).toHaveAttribute('aria-pressed', 'true');
      const writes = await holdRequests(page, base + '/wishes');
      await doublePress(button(page, t.wishStep.save));
      await expect.poll(() => writes.length).toBe(1);
      const wishes = { mood: 'quiet', drink: 'tea', note: 'My new note' };
      expect(writes[0]!.request().postDataJSON()).toEqual(wishes);
      await writes[0]!.abort('internetdisconnected');
      const retry = button(page, t.retry);
      await expectFits(retry);
      await retry.click();
      await expect.poll(() => writes.length).toBe(2);
      expect(writes[1]!.request().postDataJSON()).toEqual(wishes);
      await writes[1]!.fulfill({ json: { ...visit, wishes } });
      await expect(page.getByRole('status')).toContainText(t.wishStep.saved);
    });

    test('calendar, move and cancellation keep a single pending action', async ({ page }) => {
      const open = await prepare(page, locale);
      await open.click();
      const calendar = button(page, t.visit.addToCalendar);
      const links = await holdRequests(page, base + '/calendar-link');
      await expectFits(calendar);
      await doublePress(calendar);
      await expect(calendar).toBeDisabled();
      await expect.poll(() => links.length).toBe(1);
      await links[0]!.abort('internetdisconnected');
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await expect(calendar).toBeEnabled();

      const slots = await holdRequests(page, '**/v1/public/locations/audit-studio/availability?*');
      const move = button(page, t.visit.move);
      await doublePress(move);
      await expect(page.getByRole('status')).toHaveText(t.visit.loadingSlots);
      await expect.poll(() => slots.length).toBe(1);
      await slots[0]!.abort('internetdisconnected');
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await button(page, t.retry).click();
      await expect.poll(() => slots.length).toBe(2);
      await slots[1]!.fulfill({ json: { slots: [] } });
      await expectFits(page.getByText(t.visit.noSlots, { exact: true }));
      await button(page, t.visit.moveClose).click();
      await move.click();
      await expect.poll(() => slots.length).toBe(3);
      await slots[2]!.fulfill({ json: { slots: [slot] } });
      await button(page, slot.time).click();
      const moved = {
        ...visit,
        date: slot.date,
        time: slot.time,
        start: slot.start,
        end: '2026-12-04T10:45:00Z',
      };
      for (const action of [
        {
          label: t.visit.move,
          yes: t.visit.moveYes,
          endpoint: '/reschedule',
          result: moved,
          done: t.visit.moved,
        },
        {
          label: t.visit.cancel,
          yes: t.visit.cancelYes,
          endpoint: '/cancel',
          result: { ...moved, status: 'cancelled', canChange: false },
          done: t.visit.cancelled,
        },
      ]) {
        if (action.endpoint === '/cancel') await button(page, t.visit.cancel).click();
        const dialog = page.getByRole('alertdialog', { name: action.label, exact: true });
        await expectFits(dialog);
        const writes = await holdRequests(page, base + action.endpoint);
        const yes = button(dialog, action.yes);
        await doublePress(yes);
        await expect(yes).toBeDisabled();
        await expect.poll(() => writes.length).toBe(1);
        await writes[0]!.fulfill({ json: action.result });
        await expect(page.getByRole('status').filter({ hasText: action.done })).toBeVisible();
      }
      await expectFits(page.getByText(t.visitProducts.title + ': 0', { exact: true }));
      await expectFits(button(page, t.visit.bookAgain));
    });

    test('optional coupons, products and photos recover independently', async ({ page }) => {
      const open = await prepare(page, locale);
      const coupon = { id: 'special', name: 'Studio 10%', discountGrosze: 800, problem: null };
      await reply(page, base + '/coupons', { tier: null, applied: [], available: [coupon] });
      await page.route(base + '/coupons', (route) => route.abort('internetdisconnected'), {
        times: 1,
      });
      const photos = await holdRequests(page, base + '/photos');
      const products = await holdRequests(page, base + '/products');
      await open.click();
      const coupons = page.getByRole('region', { name: t.visit.coupons, exact: true });
      await expect(coupons.getByRole('alert')).toHaveText(t.error.network);
      await expectFits(button(coupons, t.retry));
      await doublePress(button(coupons, t.retry));
      await expect(coupons).toContainText(coupon.name);
      await expect(coupons.getByRole('alert')).toHaveCount(0);
      await expectFits(coupons);
      await expect(coupons.getByRole('button')).toBeEnabled();
      await expect.poll(() => products.length).toBe(1);
      await expect.poll(() => photos.length).toBe(1);
      await products[0]!.abort('internetdisconnected');
      await photos[0]!.abort('internetdisconnected');
      const photoCard = page.getByRole('region', { name: t.wishStep.photosQ, exact: true });
      const productCard = page.getByRole('region', { name: t.visitProducts.title, exact: true });
      for (const card of [photoCard, productCard]) {
        await expect(card.getByRole('alert')).toHaveText(t.error.network);
        await expectFits(button(card, t.retry));
        await button(card, t.retry).click();
      }
      await expect.poll(() => photos.length).toBe(2);
      await photos[1]!.fulfill({ json: { items: [], deleteAfter: null } });
      await expect(photoCard).toHaveCount(0);
      await expect.poll(() => products.length).toBe(2);
      const product = {
        id: 'wax',
        name: 'Studio Wax',
        available: true,
        brand: null,
        photoId: null,
        priceGrosze: 2000,
      };
      const list = { ...emptyProducts, canChange: true, available: [product] };
      await products[1]!.fulfill({ json: list });
      await button(productCard, t.visitProducts.add).click();
      const reserve = button(productCard, t.visitProducts.reserve + ': ' + product.name);
      await expectFits(reserve);
      await doublePress(reserve);
      await expect(reserve).toBeDisabled();
      await expect.poll(() => products.length).toBe(3);
      expect(products[2]!.request().postDataJSON()).toEqual({ productId: product.id, quantity: 1 });
      await products[2]!.fulfill({
        json: {
          ...list,
          totalGrosze: 2000,
          reservations: [
            {
              id: 'item',
              productId: product.id,
              name: product.name,
              quantity: 1,
              totalGrosze: 2000,
              status: 'reserved',
            },
          ],
        },
      });
      await expect(productCard).toContainText(t.visitProducts.statusReserved);
      const giveBack = button(productCard, t.visitProducts.giveBack + ': ' + product.name);
      const removes = await holdRequests(page, base + '/products/item');
      await doublePress(giveBack);
      await expect.poll(() => removes.length).toBe(1);
      expect(removes[0]!.request().method()).toBe('DELETE');
      await removes[0]!.fulfill({ json: emptyProducts });
      await expect(productCard).toHaveCount(0);
      const couponButton = coupons.getByRole('button');
      const writes = await holdRequests(page, base + '/coupons');
      await doublePress(couponButton);
      await expect(couponButton).toBeDisabled();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]!.request().postDataJSON()).toEqual({ couponId: coupon.id });
      await writes[0]!.fulfill({ json: { ...visit, discountGrosze: 800, coupons: [coupon] } });
      await expect.poll(() => writes.length).toBe(2);
      expect(writes.map((route) => route.request().method())).toEqual(['POST', 'GET']);
      await writes[1]!.fulfill({ json: { applied: [coupon], available: [], tier: null } });
      const remove = button(coupons, t.visit.couponRemove);
      await expectFits(remove);
      await reply(page, base + '/coupons/' + coupon.id + '/remove', visit);
      await remove.click();
      await expect.poll(() => writes.length).toBe(3);
      await writes[2]!.fulfill({ json: { applied: [], available: [], tier: null } });
      await expect(coupons).toHaveCount(0);
    });

    test('cancelled visit restores its product and rebooks after the list returns', async ({
      page,
    }) => {
      const cancelled: ClientAppointment = {
        ...visit,
        status: 'cancelled',
        canChange: false,
        canChangeWishes: false,
      };
      const open = await prepare(page, locale, cancelled);
      const items = await holdRequests(page, base + '/products');
      const salonUrl = '**/v1/public/locations/' + visit.salon.slug;
      const salonRequests = await holdRequests(page, salonUrl);
      const salon = {
        ...visit.salon,
        timezone: visit.timezone,
        currency: visit.currency,
        categories: [],
        services: [{ ...visit.service, priceFromGrosze: 8000, priceToGrosze: 8000 }],
        staff: [
          {
            ...visit.staff,
            prices: [],
            serviceIds: [visit.service.id],
            languages: [],
            specialties: [],
          },
        ],
      };
      await reply(page, salonUrl + '/availability?*', { slots: [slot] });
      await reply(page, salonUrl + '/holds', {
        holdId: 'held',
        holdToken: 'audit-hold',
        expiresAt: '2026-11-26T12:00:00Z',
        start: slot.start,
        date: slot.date,
        time: slot.time,
        priceGrosze: 8000,
        currency: 'PLN',
      });
      await reply(page, '**/v1/client/holds/held/confirm', {
        manageToken: 'audit-new',
        appointment: {
          ...slot,
          service: visit.service,
          staff: visit.staff,
        },
      });
      const pickups: { productId: string; quantity: number }[] = [];
      await page.route('**/v1/public/appointments/audit-new/products', (route) => {
        pickups.push(route.request().postDataJSON());
        return route.fulfill({ json: emptyProducts });
      });
      await open.click();
      await expect.poll(() => items.length).toBe(1);
      const regular = button(page, t.visit.bookAgain);
      const loading = page.getByRole('progressbar', { name: t.visitProducts.title });
      await expect(loading).toBeVisible();
      await expect(regular).toHaveCount(0);
      await expect(button(page, t.visit.back)).toBeEnabled();
      await items[0]!.abort('internetdisconnected');
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await expect(regular).toHaveCount(0);
      await expect(button(page, t.visit.back)).toBeEnabled();
      await doublePress(button(page, t.retry));
      await expect.poll(() => items.length).toBe(2);
      await expect(loading).toBeVisible();
      await expect(regular).toHaveCount(0);
      const reservation = {
        id: 'item',
        productId: 'wax',
        name: 'Studio Wax',
        quantity: 1,
        status: 'reserved',
        totalGrosze: 2000,
      };
      await items[1]!.fulfill({ json: { ...emptyProducts, reservations: [reservation] } });
      const card = page.getByRole('region', { name: t.visitProducts.moveTitle });
      await expectFits(card);
      await expect(card).toContainText(reservation.name);
      await expect(button(page, t.visit.bookAgain)).toHaveCount(0);
      await doublePress(button(card, t.visitProducts.moveBook));
      await expect.poll(() => salonRequests.length).toBe(1);
      await salonRequests[0]!.fulfill({ json: salon });
      await expectFits(page.getByRole('heading', { name: t.book.pickTime, exact: true }));
      await button(page, slot.time).click();
      await page.getByRole('textbox', { name: t.book.name, exact: true }).fill('Alex Nowak');
      await page.getByRole('textbox', { name: t.book.phone, exact: true }).fill('600100200');
      await page.getByRole('checkbox', { name: t.book.acceptTerms, exact: true }).click();
      await button(page, t.book.confirm).click();
      await expect(page.getByRole('status')).toContainText(
        fill(t.visitProducts.brought, { n: String(reservation.quantity) }),
      );
      expect(pickups).toEqual([
        { productId: reservation.productId, quantity: reservation.quantity },
      ]);
    });

    test('completed visit retries its review and reserves used products once', async ({ page }) => {
      const past: ClientAppointment = {
        ...visit,
        status: 'completed',
        date: '2026-11-23',
        start: '2026-11-23T09:00:00Z',
        end: '2026-11-23T09:45:00Z',
        canChange: false,
        canChangeWishes: false,
      };
      const open = await prepare(page, locale, past);
      const product = {
        id: 'pomade',
        name: 'Studio Pomade',
        brand: null,
        priceGrosze: 3000,
        photoId: null,
        available: true,
        reservedForNext: false,
      };
      const used = {
        products: [product],
        nextVisit: { date: visit.date, time: visit.time, staffName: visit.staff.displayName },
        currency: 'PLN',
        rebook: visit.bookAgain,
      };
      await reply(page, base + '/products/used', used);
      const reviews = await holdRequests(page, base + '/review');
      await open.click();
      await expect.poll(() => reviews.length).toBe(1);
      await reviews[0]!.abort('internetdisconnected');
      await expect(page.getByRole('alert')).toHaveText(t.error.network);
      await button(page, t.retry).click();
      await expect.poll(() => reviews.length).toBe(2);
      await reviews[1]!.fulfill({ json: { canReview: true, reviewUntil: null, review: null } });
      const review = page.getByRole('region', { name: t.review.title });
      await button(review, t.review.send).click();
      await expect(review.getByRole('alert')).toContainText(t.review.badRating);
      const stars = review.getByRole('radio', { name: fill(t.review.outOf, { n: '4' }) });
      await stars.click();
      await review.getByRole('textbox').fill('Thank you');
      await doublePress(button(review, t.review.send));
      await expect.poll(() => reviews.length).toBe(3);
      expect(reviews[2]!.request().postDataJSON()).toEqual({ rating: 4, text: 'Thank you' });
      await reviews[2]!.fulfill({
        json: { canReview: true, reviewUntil: null, review: { rating: 4, text: 'Thank you' } },
      });
      await expectFits(review.getByRole('status').filter({ hasText: t.review.thanks }));

      const card = page.getByRole('region', { name: t.visitProducts.usedTitle });
      const save = button(card, t.visitProducts.saveForNext + ': ' + product.name);
      await expectFits(save);
      const writes = await holdRequests(page, base + '/products/next');
      await doublePress(save);
      await expect(save).toBeDisabled();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]!.request().postDataJSON()).toEqual({ productId: product.id, quantity: 1 });
      await writes[0]!.fulfill({
        json: { ...used, products: [{ ...product, reservedForNext: true }] },
      });
      await expectFits(card.getByRole('status'));
      await expect(page.getByRole('region', { name: t.wishStep.photosQ })).toHaveCount(0);
      await expect(page.getByRole('region', { name: t.visitProducts.title })).toHaveCount(0);
    });
  });
}
