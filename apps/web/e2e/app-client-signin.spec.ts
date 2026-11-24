import { expect, test } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const languages = {
  pl: { option: 'Polski', badge: 'PL', subject: /Kod logowania do Twoich wizyt/ },
  en: { option: 'English', badge: 'EN', subject: /Your sign-in code for My visits/ },
  uk: { option: 'UA · Українська', badge: 'UA', subject: /Код входу до ваших візитів/ },
  ru: { option: 'Русский', badge: 'RU', subject: /Код входа в ваши визиты/ },
};

async function mailedCode(email: string, subject: RegExp) {
  const mail = await waitForEmail(email, subject);
  const match = /\b\d{6}\b/.exec(mail.text);
  if (!match) throw new Error('Expected a six-digit sign-in code in the email');
  return match[0];
}

test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

for (const [from, to] of [
  ['pl', 'en'],
  ['en', 'uk'],
  ['uk', 'ru'],
  ['ru', 'pl'],
] as const) {
  test.describe(`${from} → ${to}`, () => {
    test.use({ locale: from });

    test('signs in with a replacement code and keeps recent salons at 320 px', async ({ page }) => {
      const app = await serveApp('mobile-client');
      const email = `signin-${to}-${Date.now()}@example.com`;
      const salon = { slug: 'studio-k', name: 'Studio K' };
      const before = DICTIONARIES[from];
      const after = DICTIONARIES[to];
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      try {
        await page.setExtraHTTPHeaders(freshAddress());
        await page.addInitScript((salon) => {
          localStorage.setItem('beauty.catalog.recent', JSON.stringify([salon]));
        }, salon);
        await page.goto(app.url);
        const brand = page.getByText(before.appTitle.toUpperCase(), { exact: true });
        await brand.scrollIntoViewIfNeeded();
        await expect(brand).toBeInViewport();
        await page.getByRole('textbox', { name: before.signIn.email, exact: true }).fill(email);
        await button(before.signIn.sendCode).click();
        const firstCode = await mailedCode(email, languages[from].subject);
        const code = page.getByRole('textbox', { name: before.signIn.code, exact: true });
        const wrongCode = firstCode === '000000' ? '000001' : '000000';
        await code.fill(wrongCode);
        await button(before.signIn.confirm).click();
        await expect(code).toHaveAttribute('aria-invalid', 'true');
        const alert = page.getByRole('alert');
        await expect(alert).toHaveText(`! ${before.signIn.badCode}`);

        await button(before.language).click();
        const option = button(languages[to].option);
        await option.scrollIntoViewIfNeeded();
        await expect(option).toBeInViewport();
        await option.click();
        await expect(button(after.language)).toHaveText(`${languages[to].badge} ▾`);
        await expect(page.locator('html')).toHaveAttribute('lang', to);
        const translatedCode = page.getByRole('textbox', { name: after.signIn.code, exact: true });
        await expect(translatedCode).toHaveValue(wrongCode);
        await expect(alert).toHaveText(`! ${after.signIn.badCode}`);

        // Only expiry is simulated, so the test does not wait for the ten-minute lifetime.
        await page.route(
          '**/v1/client/auth/verify',
          (route) =>
            route.fulfill({
              status: 410,
              json: { error: { code: 'CODE_EXPIRED', message: 'The code has expired' } },
            }),
          { times: 1 },
        );
        await translatedCode.fill(firstCode);
        await button(after.signIn.confirm).click();
        await expect(translatedCode).toHaveAttribute('aria-invalid', 'true');
        await expect(alert).toHaveText(`! ${after.signIn.newCodeNeeded}`);
        await button(after.signIn.resend).click();
        await expect(translatedCode).toHaveValue('');
        await expect(alert).toHaveCount(0);
        await expect(button(after.signIn.confirm)).toBeDisabled();
        await translatedCode.fill(await mailedCode(email, languages[to].subject));
        await button(after.signIn.confirm).click();
        await expect(
          page.getByText(fill(after.visits.signedInAs, { email }), { exact: true }),
        ).toBeVisible();
        const recent = page.getByRole('group', { name: after.catalog.recent, exact: true });
        await expect(recent.getByRole('button', { name: salon.name, exact: true })).toBeVisible();
        await recent.getByRole('button', { name: after.catalog.recentClear, exact: true }).click();
        await expect(recent).toHaveCount(0);
      } finally {
        app.server.close();
      }
    });
  });
}
