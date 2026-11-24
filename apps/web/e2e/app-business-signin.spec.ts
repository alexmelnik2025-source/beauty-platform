import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-business/src/i18n';
import { freshAddress } from './addresses';
import { listTo, textOf, waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const languages = {
  pl: 'PL · Polski',
  en: 'EN · English',
  uk: 'UA · Українська',
  ru: 'RU · Русский',
} as const;
const salons = ['Studio Centrum', 'Studio Fryzjerskie Warszawa Południe'] as const;
const loginSubject = 'Kod logowania do aplikacji salonu';

async function ownerWithSalons(
  api: APIRequestContext,
  email: string,
  headers: Record<string, string>,
) {
  const account = { email, password: 'e2e-password-123' };
  await expect(
    await api.post('/v1/auth/register', { headers, data: { ...account, name: 'Salon Owner' } }),
  ).toBeOK();
  const verification = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(verification.text)![1]!;
  await expect(
    await api.post('/v1/auth/verify-email', {
      headers,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await api.post('/v1/auth/login', {
    headers,
    data: { ...account, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const owner = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const org = await api.post('/v1/organizations', { headers: owner, data: { name: 'Studio' } });
  await expect(org).toBeOK();
  const { id } = await org.json();
  for (const name of salons) {
    await expect(
      await api.post(`/v1/organizations/${id}/locations`, {
        headers: owner,
        data: { name, city: 'Warszawa', addressLine: 'ul. Testowa 1', postalCode: '00-001' },
      }),
    ).toBeOK();
  }
}

async function loginMail(email: string, previousId?: string) {
  async function newest() {
    return (await listTo(email)).find((m) => m.Subject === loginSubject && m.ID !== previousId);
  }
  await expect.poll(newest).not.toBeUndefined();
  const { ID } = (await newest())!;
  const code = /\b(\d{6})\b/.exec(await textOf(ID))![1]!;
  return { id: ID, code };
}

// Check the actual text fragments as well as the page width: an overflow-hidden
// container can hide a translated label without widening the document.
async function fitsPhone(page: Page) {
  const clipped = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const walker = document.createTreeWalker(
      document.getElementById('root')!,
      NodeFilter.SHOW_TEXT,
    );
    const outside: string[] = [];
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      if ([...range.getClientRects()].some((r) => r.left < -1 || r.right > width + 1)) {
        outside.push(walker.currentNode.textContent ?? '');
      }
    }
    return { width, scrollWidth: document.documentElement.scrollWidth, outside };
  });
  expect(clipped).toEqual({ width: 320, scrollWidth: 320, outside: [] });
}

async function switchLanguage(page: Page, locale: keyof typeof languages) {
  await page.getByRole('button', { expanded: false }).click();
  await fitsPhone(page);
  await page.getByRole('button', { name: languages[locale], exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

for (const locale of ['pl', 'en', 'uk', 'ru'] as const) {
  test(`business sign-in, resend and salon choice at 320 px (${locale})`, async ({
    page,
    request,
  }) => {
    const headers = freshAddress();
    const email = `signin-${locale}-${Date.now()}@example.com`;
    await ownerWithSalons(request, email, headers);
    const app = await serveApp('mobile-business');
    const t = DICTIONARIES[locale];
    try {
      await page.setExtraHTTPHeaders(headers);
      await page.goto(app.url);
      await switchLanguage(page, locale);
      await expect(page.getByRole('heading', { name: t.signIn.title })).toBeVisible();
      await fitsPhone(page);
      await page.getByRole('textbox', { name: t.signIn.contact }).fill(email);
      await page.getByRole('button', { name: t.signIn.sendCode, exact: true }).click();
      await expect(
        page.getByText(fill(t.signIn.sentEmail, { to: email }), { exact: true }),
      ).toBeVisible();
      const first = await loginMail(email);
      const field = page.getByRole('textbox', { name: t.signIn.code, exact: true });
      await field.fill(first.code === '000000' ? '000001' : '000000');
      await page.getByRole('button', { name: t.signIn.confirm, exact: true }).click();
      const alert = page.getByRole('alert');
      await expect(alert).toHaveText(`! ${t.signIn.badCode}`);
      const codeBox = (await field.boundingBox())!;
      const errorBox = (await alert.boundingBox())!;
      expect(errorBox.y).toBeGreaterThanOrEqual(codeBox.y + codeBox.height - 1);
      expect(errorBox.y - (codeBox.y + codeBox.height)).toBeLessThan(24);
      await expect(field).toHaveAccessibleDescription(`! ${t.signIn.badCode}`);
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await fitsPhone(page);

      const alternate = locale === 'en' ? 'pl' : 'en';
      await switchLanguage(page, alternate);
      const other = DICTIONARIES[alternate].signIn;
      await expect(
        page.getByText(fill(other.sentEmail, { to: email }), { exact: true }),
      ).toBeVisible();
      await expect(alert).toHaveText(`! ${other.badCode}`);
      await switchLanguage(page, locale);

      await page.getByRole('button', { name: t.signIn.sendCode, exact: true }).click();
      const second = await loginMail(email, first.id);
      await expect(field).toHaveValue('');
      await expect(alert).toHaveCount(0);
      await field.fill(second.code);
      await page.getByRole('button', { name: t.signIn.confirm, exact: true }).click();
      await expect(page.getByRole('heading', { name: t.salons.title })).toBeVisible();
      for (const name of salons) {
        await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
      }
      await fitsPhone(page);
      await page.getByRole('button', { name: salons[1], exact: true }).click();
      await expect(
        page.getByRole('tab', { name: t.navigation.calendar, exact: true }),
      ).toBeVisible();
      await expect(page.getByText(salons[1], { exact: true })).toBeVisible();
    } finally {
      app.server.close();
    }
  });
}
