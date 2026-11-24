import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ClientAppointment } from '../../mobile-client/src/api';
import { formatPrice } from '../../mobile-client/src/format';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

const salon = {
  name: 'Studio Nova',
  slug: 'studio-nova',
  city: 'Warszawa',
  postalCode: '01-233',
  addressLine: 'Bema 91',
  phone: null,
  currency: 'PLN',
  timezone: 'Europe/Warsaw',
  languages: [],
};
const visit: ClientAppointment = {
  id: 'visit',
  salon,
  status: 'cancelled',
  date: '2026-11-20',
  time: '12:00',
  start: '2026-11-20T11:00:00Z',
  end: '2026-11-20T11:30:00Z',
  timezone: salon.timezone,
  currency: salon.currency,
  service: { id: 'cut', name: 'Classic', durationMinutes: 30, priceGrosze: 8000 },
  staff: { id: 'alex', displayName: 'Alex' },
  changeableUntil: '2026-11-19T11:00:00Z',
  canChange: false,
  awaitingApproval: false,
  wishes: { mood: null, drink: null, note: null },
  wishQuestions: { mood: false, drinks: [], note: false },
  canChangeWishes: false,
  bookAgain: { slug: salon.slug, serviceId: 'cut', staffId: 'alex' },
  coupons: [],
  discountGrosze: 0,
};

async function reply(page: Page, path: string, json: unknown, status = 200) {
  await page.route(path, (route) => route.fulfill({ status, json }));
}

// Expo's web preview uses pixel sizes. Check that Chromium actually enlarges the text.
async function enlargeText(page: Page, text: Locator) {
  const fontSize = () => text.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(320);
}

async function expectFits(block: Locator) {
  await expect(block).toBeVisible();
  const clipped = await block.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    if (bounds.left < -1 || bounds.right > 321) return ['block outside viewport'];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const issues = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const box = node.parentElement!.getBoundingClientRect();
      for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        if (
          Array.from(range.getClientRects()).some(
            (rect) =>
              rect.left < Math.max(bounds.left, box.left) - 1 ||
              rect.right > Math.min(bounds.right, box.right) + 1 ||
              rect.top < Math.max(bounds.top, box.top) - 1 ||
              rect.bottom > Math.min(bounds.bottom, box.bottom) + 1,
          )
        )
          issues.push(word[0]);
      }
    }
    return issues;
  });
  expect(clipped).toEqual([]);
}

for (const locale of ['en', 'uk', 'ru'] as const) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 844 }, isMobile: true });
    const t = DICTIONARIES[locale];

    test('salon hours, QR, voucher field and reviews at 130%', async ({ page }) => {
      const base = `**/v1/public/locations/${salon.slug}`;
      const hours = [{ start: '09:00', end: '18:00' }];
      await page.clock.setFixedTime(new Date('2026-11-24T11:00:00Z'));
      const listing = {
        ...salon,
        todayHours: hours,
        distanceKm: null,
        rating: null,
        priceFromGrosze: null,
      };
      await reply(page, '**/v1/public/locations?**', {
        items: [listing, { ...listing, name: 'Studio Luna', slug: 'luna', todayHours: [] }],
        total: 2,
        page: 1,
        pageCount: 1,
        openNowCount: 1,
        languageCounts: {},
        specialtyCounts: {},
      });
      await reply(page, base, {
        ...salon,
        todayHours: { date: '2026-11-24', intervals: hours },
        openingHours: [],
        services: [],
        categories: [],
        photos: [],
        staff: [],
      });
      await reply(page, base + '/free-today', { staffIds: [] });
      const reviewsUrl = base + '/reviews';
      const empty = {
        enabled: true,
        count: 0,
        average: null,
        stars: [0, 0, 0, 0, 0],
        staff: [],
        items: [],
        nextBefore: null,
      };
      await reply(page, reviewsUrl, empty);
      await reply(page, base + '/gift-vouchers/BAD1', { error: { code: 'NOT_FOUND' } }, 404);
      await reply(page, base + '/gift-vouchers/GOOD1234', {
        code: 'GOOD1234',
        status: 'active',
        currency: 'PLN',
        balanceGrosze: 1250,
        amountGrosze: 5000,
        validUntil: null,
      });
      const app = await serveApp('mobile-client');
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      try {
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await enlargeText(page, page.getByText(t.catalog.startLead, { exact: true }));
        await button(t.catalog.searchGo).click();
        const card = page.getByRole('article', { name: salon.name });
        for (const [listingCard, status] of [
          [card, fill(t.salon.openUntil, { time: '18:00' })],
          [page.getByRole('article', { name: 'Studio Luna' }), t.salon.closedNow],
        ] as const) {
          const label = listingCard.getByLabel(status, { exact: true });
          await expect(label).toContainText(status);
          await expectFits(label);
        }
        const seeSalon = card.getByRole('button', { name: t.catalog.open });
        await seeSalon.click();
        await button(t.salon.about + ' ▸').click();
        await button(t.salon.qrShow).click();
        const qr = page.getByRole('img', { name: t.salon.qrAlt, exact: true });
        await expect(qr).toBeVisible();
        const { width, height, x } = (await qr.boundingBox())!;
        const qrCard = (await qr.locator('..').boundingBox())!;
        expect(x).toBeGreaterThanOrEqual(qrCard.x);
        expect(x + width).toBeLessThanOrEqual(qrCard.x + qrCard.width);
        expect(width).toBeGreaterThan(150);
        expect(width).toBeCloseTo(height, 0);
        await expectFits(qr.locator('..'));
        await button(t.salon.qrHide).click();
        await expect(qr).toHaveCount(0);

        await expectFits(button(t.voucherCheck.open));
        await button(t.voucherCheck.open).click();
        const code = page.getByRole('textbox', { name: t.voucherCheck.code });
        const check = button(t.voucherCheck.check);
        await expect(check).toBeDisabled();
        await code.fill('BAD1');
        await check.click();
        const alert = page.getByRole('alert');
        const message = `! ${t.voucherCheck.notFound}`;
        await expect(alert).toHaveText(message);
        await expect(code).toHaveAccessibleDescription(message);
        await expect(code).toHaveAttribute('aria-invalid', 'true');
        const inputBox = (await code.boundingBox())!;
        expect((await alert.boundingBox())!.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
        await expectFits(code.locator('..'));
        await code.fill('GOOD1234');
        await expect(alert).toHaveCount(0);
        await check.click();
        const result = page.getByRole('status').filter({ hasText: t.voucherCheck.payAtSalon });
        await expect(result).toContainText(
          fill(t.voucherCheck.left, {
            left: formatPrice(1250, 'PLN', locale),
            amount: formatPrice(5000, 'PLN', locale),
          }),
        );
        await expect(result).toContainText(
          t.voucherCheck.statusActive + ' · ' + t.voucherCheck.noEnd,
        );
        await expectFits(result);

        const reviews = page.getByRole('region', { name: t.salonReviews.title, exact: true });
        await expect(reviews.getByRole('status')).toHaveText(`${t.salonReviews.title}: 0`);
        await expectFits(reviews);
        await reply(page, reviewsUrl, {
          ...empty,
          count: 1,
          stars: [0, 0, 0, 0, 1],
          average: 5,
          items: [
            {
              id: 'review',
              rating: 5,
              staffName: 'Alex',
              serviceName: 'Classic',
              text: 'Studio Nova',
              reply: 'Merci!',
              createdAt: '2026-11-20T12:00:00Z',
            },
          ],
        });
        await button(t.salon.back).click();
        await seeSalon.click();
        await expect(
          reviews.getByRole('img', { name: fill(t.review.outOf, { n: '5' }) }),
        ).toBeVisible();
        await expect(reviews.getByLabel(t.salonReviews.salonReply + ': Merci!')).toBeVisible();
        await expectFits(reviews);
      } finally {
        app.server.close();
      }
    });

    test('cancelled visit with and without products at 130%', async ({ page }) => {
      const product = {
        id: 'reservation',
        productId: 'pomade',
        name: 'Studio Nova Professional Styling Pomade',
        quantity: 2,
        unitPriceGrosze: 2950,
        totalGrosze: 5900,
        status: 'reserved',
      };
      await page.addInitScript(() => localStorage.setItem('beauty.client.session', 'test-session'));
      await reply(page, '**/v1/client/me', { email: 'client@example.test', locale });
      await reply(page, '**/v1/client/me/summary', {
        completed: 0,
        salons: 0,
        firstVisitAt: null,
        spent: [],
      });
      await reply(page, '**/v1/client/waitlist', { items: [] });
      await reply(page, '**/v1/client/appointments?scope=upcoming', { items: [] });
      await reply(page, '**/v1/client/appointments?scope=past', { items: [visit] });
      const detail = '**/v1/client/appointments/visit';
      await reply(page, detail, visit);
      await reply(page, detail + '/photos', { items: [], deleteAfter: null });
      await reply(page, detail + '/products', {
        currency: 'PLN',
        canChange: false,
        reservations: [],
      });
      const app = await serveApp('mobile-client');
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      try {
        await page.goto(app.url);
        const heading = page.getByRole('heading', { name: t.visits.title, exact: true });
        await expect(heading).toBeVisible();
        await enlargeText(page, heading);
        await page.getByRole('tab', { name: t.visits.past, exact: true }).click();
        const openVisit = button(`${visit.time} ${visit.service.name}, ${salon.name}`);
        await openVisit.click();
        const empty = page.getByRole('status').filter({ hasText: `${t.visitProducts.title}: 0` });
        await expectFits(empty);
        await expectFits(button(t.visit.bookAgain));
        await expect(button(t.visitProducts.moveBook)).toHaveCount(0);
        await button(t.visit.back).click();
        await reply(page, detail + '/products', {
          currency: 'PLN',
          canChange: false,
          reservations: [product],
        });
        await openVisit.click();
        const card = page.getByRole('region', { name: t.visitProducts.moveTitle, exact: true });
        await expect(card.getByRole('heading')).toHaveText(t.visitProducts.moveTitle);
        await expect(card).toContainText(product.name + ' × 2');
        await expect(card).toContainText(formatPrice(product.totalGrosze, 'PLN', locale));
        await expect(card).toContainText(t.visitProducts.moveLead);
        await expect(button(t.visit.bookAgain)).toHaveCount(0);
        await expect(
          card.getByRole('button', { name: t.visitProducts.moveBook, exact: true }),
        ).toBeEnabled();
        await expectFits(card);
      } finally {
        app.server.close();
      }
    });
  });
}
