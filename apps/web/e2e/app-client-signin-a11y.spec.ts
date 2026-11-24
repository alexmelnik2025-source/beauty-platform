import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, LANGUAGE_NAMES } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

async function expectTouchTarget(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = (await control.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(321);
}

// Expo assigns pixel sizes. Enlarge each rendered label and input once, including newly shown errors.
async function expectLargeTextToFit(page: Page) {
  const clipped = await page.locator('#root').evaluate((root) => {
    const labels = [...root.querySelectorAll<HTMLElement>('*')].filter(
      (el) => !el.childElementCount && (el.textContent?.trim() || el instanceof HTMLInputElement),
    );
    for (const el of labels) {
      if (el.dataset.largeText) continue;
      const style = getComputedStyle(el);
      const lineHeight = parseFloat(style.lineHeight);
      el.style.fontSize = parseFloat(style.fontSize) * 1.3 + 'px';
      if (Number.isFinite(lineHeight)) el.style.lineHeight = lineHeight * 1.3 + 'px';
      el.dataset.largeText = 'true';
    }
    return labels
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return (
          box.left < -1 ||
          box.right > root.clientWidth + 1 ||
          el.scrollWidth > el.clientWidth + 1 ||
          el.scrollHeight > el.clientHeight + 1
        );
      })
      .map((el) => el.textContent || el.getAttribute('aria-label'));
  });
  expect(clipped).toEqual([]);
}

for (const [initial, locale] of [
  ['ru', 'pl'],
  ['pl', 'en'],
  ['en', 'uk'],
  ['uk', 'ru'],
] as const) {
  test.describe(locale, () => {
    test.use({ locale: initial });

    test('sign-in fields, errors and language choices at 320 px with 130% text', async ({
      page,
    }) => {
      const app = await serveApp('mobile-client');
      const t = DICTIONARIES[locale];
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const salon = {
        slug: 'recent-studio',
        name: 'Studio Fryzur i Pielęgnacji Włosów w Warszawie',
      };
      try {
        await page.addInitScript((entry) => {
          localStorage.setItem('beauty.catalog.recent', JSON.stringify([entry]));
        }, salon);
        await page.route('**/v1/client/auth/code', (route) =>
          route.fulfill({ json: { codeExpiresAt: new Date(Date.now() + 600_000).toISOString() } }),
        );
        await page.route('**/v1/client/auth/verify', (route) =>
          route.fulfill({
            status: 410,
            json: { error: { code: 'CODE_EXPIRED', message: 'Expired' } },
          }),
        );
        await page.goto(app.url);
        const picker = button(DICTIONARIES[initial].language);
        await expectTouchTarget(picker);
        await picker.click();
        await expect(picker).toHaveAttribute('aria-expanded', 'true');
        const choices = page.getByRole('group', {
          name: DICTIONARIES[initial].language,
          exact: true,
        });
        const options = choices.getByRole('button');
        await expectLargeTextToFit(page);
        for (const option of await options.all()) await expectTouchTarget(option);
        const languageName = (l: typeof locale) =>
          l === 'uk' ? 'UA · ' + LANGUAGE_NAMES[l] : LANGUAGE_NAMES[l];
        await expect(
          choices.getByRole('button', { name: languageName(initial), exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
        await choices.getByRole('button', { name: languageName(locale), exact: true }).click();
        await expect(button(t.language)).toHaveAttribute('aria-expanded', 'false');

        const email = page.getByRole('textbox', { name: t.signIn.email, exact: true });
        await expectTouchTarget(email);
        await expectTouchTarget(button(salon.name));
        await expectTouchTarget(button(t.catalog.recentClear));
        await email.fill('invalid');
        await button(t.signIn.sendCode).click();
        await expect(email).toBeFocused();
        await expect(email).toHaveAccessibleDescription('! ' + t.signIn.badEmail);
        await expectLargeTextToFit(page);
        await email.fill('client@example.com');
        await expect(email).toHaveAttribute('aria-invalid', 'false');
        await button(t.signIn.sendCode).click();

        const code = page.getByRole('textbox', { name: t.signIn.code, exact: true });
        await expectLargeTextToFit(page);
        await expectTouchTarget(code);
        await code.fill('123456');
        await expectTouchTarget(button(t.signIn.confirm));
        await button(t.signIn.confirm).click();
        await expect(code).toBeFocused();
        await expect(code).toHaveAttribute('aria-invalid', 'true');
        await expect(code).toHaveAccessibleDescription('! ' + t.signIn.newCodeNeeded);
        await expectLargeTextToFit(page);
        const resend = button(t.signIn.resend);
        await expectTouchTarget(resend);
        await expectTouchTarget(button(t.signIn.otherEmail));
        await resend.click();
        await expect(code).toHaveValue('');
        await expect(code).toHaveAccessibleDescription('');
        await expect(page.getByRole('alert')).toHaveCount(0);
      } finally {
        app.server.close();
      }
    });
  });
}
