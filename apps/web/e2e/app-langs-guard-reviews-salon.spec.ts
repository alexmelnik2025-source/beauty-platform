import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { en } from '../../mobile-business/src/locales/en';
import { ru } from '../../mobile-business/src/locales/ru';
import { uk } from '../../mobile-business/src/locales/uk';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

async function salonOwner(request: APIRequestContext) {
  const email = `au-${Date.now().toString(36)}@example.com`;
  const account = { email, password: 'e2e-password-123' };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Alex' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await request.post('/v1/auth/login', {
    headers: address,
    data: { ...account, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const session = await login.json();
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const org = await request.post('/v1/organizations', { headers, data: { name: 'Salon AU' } });
  await expect(org).toBeOK();
  const salon = await request.post(`/v1/organizations/${(await org.json()).id}/locations`, {
    headers,
    data: { name: 'Salon AU', addressLine: 'Bema 91', city: 'Warszawa', postalCode: '01-233' },
  });
  await expect(salon).toBeOK();
  return session.refreshToken as string;
}

async function expectLayout(page: Page) {
  const issues = await page.evaluate(() => {
    const issues: string[] = [];
    if (innerWidth !== 320) issues.push(`Viewport widened to ${innerWidth}px`);
    const controls = document.querySelectorAll<HTMLElement>(
      'button, input, textarea, [role=button], [role=radio], [role=checkbox]',
    );
    for (const el of controls) {
      const box = el.getBoundingClientRect();
      if (box.width < 44 || box.height < 44 || box.left < -1 || box.right > innerWidth + 1)
        issues.push(`Control bounds: ${el.getAttribute('aria-label')}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>('[dir=auto]')) {
      if (!el.textContent?.trim() || el.childElementCount) continue;
      const box = el.getBoundingClientRect();
      const range = document.createRange();
      // React Native Web preserves spaces at soft wraps. Measure the printed words.
      const node = el.firstChild!;
      for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        if (
          Array.from(range.getClientRects()).some(
            (line) =>
              line.left < Math.max(0, box.left) - 1 ||
              line.right > Math.min(innerWidth, box.right) + 1 ||
              line.top < box.top - 1 ||
              line.bottom > box.bottom + 1,
          )
        ) {
          issues.push(`Clipped text: ${word[0]} in ${el.textContent}`);
          break;
        }
      }
    }
    // Check adjacent controls even when a translated label wraps onto a new row.
    for (const el of controls) {
      for (const sibling of el.parentElement?.children ?? []) {
        if (sibling === el) continue;
        const a = el.getBoundingClientRect();
        const b = sibling.getBoundingClientRect();
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        )
          issues.push(`Overlap: ${el.getAttribute('aria-label')} / ${sibling.textContent}`);
      }
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

async function expectFieldError(field: Locator, message: string) {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(`! ${message}`);
  const alert = field.locator('..').getByRole('alert');
  await expect(alert).toHaveText(`! ${message}`);
  await alert.scrollIntoViewIfNeeded();
  await expect(alert).toBeInViewport({ ratio: 1 });
  const input = (await field.boundingBox())!;
  expect((await alert.boundingBox())!.y).toBeGreaterThanOrEqual(input.y + input.height - 1);
}

for (const [locale, t] of [
  ['en', en],
  ['uk', uk],
  ['ru', ru],
] as const) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 844 }, isMobile: true });
    test('guard, reviews and salon details at 130% text size', async ({ page, request }) => {
      const refresh = await salonOwner(request);
      const app = await serveApp('mobile-business');
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const heading = (name: string) => page.getByRole('heading', { name, exact: true });
      try {
        await page.addInitScript(
          (token) => localStorage.setItem('beauty.business.refreshToken', token),
          refresh,
        );
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await page.getByRole('tab', { name: t.navigation.more, exact: true }).click();
        await button(t.guard.open).click();
        const title = heading(t.guard.title);
        await expect(title).toBeVisible();
        const normalSize = await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important; }' });
        expect(await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(
          normalSize * 1.3,
          1,
        );

        await button(t.guard.rulesChange).click();
        await page.getByRole('checkbox', { name: t.guard.changesOn }).click();
        const limit = page.getByRole('textbox', { name: t.guard.changes, exact: true });
        await limit.fill('0');
        await button(t.guard.rulesSave).click();
        await expectFieldError(limit, t.guard.problem.changes);
        await expectLayout(page);
        await limit.fill('3');
        await expect(page.getByRole('alert')).toHaveCount(0);
        await button(t.guard.back).click();

        const reviewText = 'Alexandra'.repeat(20);
        await page.route('**/locations/*/reviews', (route) =>
          route.fulfill({
            json: {
              enabled: true,
              count: 1,
              average: 4,
              stars: [0, 0, 0, 1, 0],
              unanswered: 1,
              staff: [],
              services: [],
              nextBefore: null,
              items: [
                {
                  id: 'au-review',
                  rating: 4,
                  text: reviewText,
                  staffName: 'Alex',
                  serviceName: 'Cut',
                  customerName: 'Anna',
                  visitStartAt: '2026-11-20T10:00:00Z',
                  reply: null,
                },
              ],
            },
          }),
        );
        await button(t.reviews.open).click();
        await expect(heading(t.reviews.title)).toBeVisible();
        await expect(page.getByText(reviewText, { exact: true })).toBeVisible();
        await button(t.reviews.collect).click();
        await button(t.reviews.reply).click();
        const reply = page.getByRole('textbox', { name: t.reviews.replyLabel });
        await button(t.reviews.replySave).click();
        await expectFieldError(reply, t.reviews.reply);
        await expectLayout(page);
        await reply.fill('✓');
        await expect(page.getByRole('alert')).toHaveCount(0);
        await button(t.reviews.back).click();

        await button(t.navigation.settings).click();
        await expect(heading(t.navigation.settings)).toBeVisible();
        await button(t.navigation.salonDetails).waitFor();
        await expectLayout(page);
        await button(t.salon.country).click();
        await expect(heading(t.salon.country)).toBeVisible();
        await expectLayout(page);
        await button(`‹ ${t.navigation.settings}`).click();
        await button(t.navigation.salonDetails).click();
        await expect(heading(t.navigation.salonDetails)).toBeVisible();
        const phone = page.getByRole('textbox', { name: t.salon.phone });
        await phone.fill('123');
        await button(t.salon.save).click();
        await expectFieldError(phone, t.salon.badPhone);
        await expectLayout(page);
        await button(t.navigation.discard).click();
        await expect(page.getByRole('alert')).toHaveCount(0);
      } finally {
        app.server.close();
      }
    });
  });
}
