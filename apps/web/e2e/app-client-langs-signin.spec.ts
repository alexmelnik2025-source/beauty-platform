import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-client/src/i18n';
import { serveApp } from './mobile-app';

test.use({ locale: 'pl', viewport: { width: 320, height: 568 }, isMobile: true });

const salons = [
  'Riverside Hair Studio and Colour Specialists',
  'Студія зачісок та відновлення волосся на Подолі',
  'Мастерская стрижки и окрашивания на набережной',
  'PracowniaFryzjerskaAleksandryKonstantynowicz',
  'Atelier de coiffure du quartier Saint-Germain',
].map((name, i) => ({ slug: 'studio-' + i, name }));

// Expo web uses pixel sizes. Scale the styles of both initial and later form states.
async function enlargeText(page: Page, field: Locator) {
  const size = () => field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await size();
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const property of ['font-size', 'line-height']) {
          const value = rule.style.getPropertyValue(property);
          if (value.endsWith('px'))
            rule.style.setProperty(property, parseFloat(value) * 1.3 + 'px');
        }
      }
    }
  });
  expect(await size()).toBeCloseTo(original * 1.3, 1);
}

async function expectFits(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const fits = await control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(el);
    return (
      box.left >= 0 &&
      box.right <= 320 &&
      Array.from(text.getClientRects()).every(
        (line) =>
          line.left >= box.left - 1 &&
          line.right <= box.right + 1 &&
          line.top >= box.top - 1 &&
          line.bottom <= box.bottom + 1,
      )
    );
  });
  expect(fits, control.toString()).toBe(true);
}

async function expectFieldError(field: Locator, message: string) {
  const alert = field.page().getByRole('alert');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription('! ' + message);
  await expect(alert).toHaveText('! ' + message);
  await expectFits(alert);
  const inputBox = (await field.boundingBox())!;
  const alertBox = (await alert.boundingBox())!;
  const gap = alertBox.y - (inputBox.y + inputBox.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(8);
}

for (const [locale, badge, option] of [
  ['en', 'EN', 'English'],
  ['uk', 'UA', 'UA · Українська'],
  ['ru', 'RU', 'Русский'],
] as const) {
  test(`${badge}: recent salons, field errors and a replacement sign-in code at 130%`, async ({
    page,
  }) => {
    const app = await serveApp('mobile-client');
    const t = DICTIONARIES[locale];
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const textbox = (name: string) => page.getByRole('textbox', { name, exact: true });
    const address = 'client@example.com';
    const requests: unknown[] = [];
    try {
      await page.addInitScript((entries) => {
        localStorage.setItem('beauty.catalog.recent', JSON.stringify(entries));
      }, salons);
      await page.route('**/v1/public/locations?**', (route) =>
        route.fulfill({ json: { openNowCount: 0 } }),
      );
      await page.route('**/v1/client/auth/code', (route) => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({
          json: { codeExpiresAt: new Date(Date.now() + 600_000).toISOString() },
        });
      });
      await page.route('**/v1/client/auth/verify', (route) => {
        const { code } = route.request().postDataJSON();
        if (code === '654321')
          return route.fulfill({
            json: {
              person: { id: 'client-bg', email: address, locale },
              token: 'test-session',
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          });
        return route.fulfill({
          status: 410,
          json: { error: { code: 'CODE_EXPIRED', message: 'Expired' } },
        });
      });
      await page.route('**/v1/client/{appointments?*,waitlist}', (route) =>
        route.fulfill({ json: { items: [] } }),
      );
      await page.goto(app.url);
      await enlargeText(page, textbox(DICTIONARIES.pl.signIn.email));
      await button(DICTIONARIES.pl.language).click();
      await expect(button('UA · Українська')).toHaveText('UA · Українська');
      await expectFits(button(option));
      await button(option).click();
      await expect(button(t.language)).toHaveText(badge + ' ▾');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);

      const recent = page.getByRole('group', { name: t.catalog.recent, exact: true });
      await expect(recent.getByRole('button')).toHaveText([
        ...salons.map((s) => s.name),
        t.catalog.recentClear,
      ]);
      await expectFits(recent.getByRole('heading', { name: t.catalog.recent }));
      for (const item of await recent.getByRole('button').all()) await expectFits(item);
      await recent.getByRole('button', { name: t.catalog.recentClear, exact: true }).click();
      await expect(recent).toHaveCount(0);

      const email = textbox(t.signIn.email);
      await expectFits(email);
      await email.fill('invalid');
      await button(t.signIn.sendCode).click();
      await expectFieldError(email, t.signIn.badEmail);
      await email.fill(address);
      await button(t.signIn.sendCode).click();
      const code = textbox(t.signIn.code);
      await expectFits(page.getByText(fill(t.signIn.sent, { email: address }), { exact: true }));
      await expectFits(code);
      expect(requests).toEqual([{ email: address, locale }]);
      await code.fill('123456');
      await button(t.signIn.confirm).click();
      await expectFieldError(code, t.signIn.newCodeNeeded);
      const resend = button(t.signIn.resend);
      await expectFits(resend);
      await expectFits(button(t.signIn.otherEmail));
      await resend.click();
      await expect(code).toHaveValue('');
      expect(requests).toEqual([
        { email: address, locale },
        { email: address, locale },
      ]);
      await expect(code).toHaveAttribute('aria-invalid', 'false');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(button(t.signIn.confirm)).toBeDisabled();

      await code.fill('654321');
      await button(t.signIn.confirm).click();
      await expect(
        page.getByText(fill(t.visits.signedInAs, { email: address }), { exact: true }),
      ).toBeVisible();
      await expect(recent).toHaveCount(0);
    } finally {
      app.server.close();
    }
  });
}
