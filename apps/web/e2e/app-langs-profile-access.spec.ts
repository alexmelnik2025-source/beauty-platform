import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { en } from '../../mobile-business/src/locales/en';
import { uk } from '../../mobile-business/src/locales/uk';
import { ru } from '../../mobile-business/src/locales/ru';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const viewport = { width: 320, height: 844 };

async function registerOwner(request: APIRequestContext, email: string) {
  const credentials = { email, password: 'e2e-password-123' };
  const headers = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers,
      data: { ...credentials, name: 'Salon owner' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      headers,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await request.post('/v1/auth/login', {
    headers,
    data: { ...credentials, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  return (await login.json()) as { accessToken: string; refreshToken: string };
}

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

async function enlargeText(page: Page, title: string) {
  const heading = page.getByRole('heading', { name: title, exact: true });
  await expect(heading).toBeVisible();
  const fontSize = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(original * 1.3, 1);
}

// A narrow ScrollView can hide overflow even when the document itself stays 320 px wide.
async function expectLayout(page: Page) {
  const issues = await page.evaluate((width) => {
    const failures: string[] = [];
    if (innerWidth !== width || document.documentElement.scrollWidth !== width)
      failures.push('page width: ' + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll(
      'button, input, [role=button], [role=radio], [role=checkbox]',
    )) {
      const box = el.getBoundingClientRect();
      if (box.width < 44 || box.height < 44 || box.left < -1 || box.right > width + 1)
        failures.push('control: ' + el.getAttribute('aria-label'));
      for (const sibling of el.parentElement?.children ?? []) {
        if (sibling === el) continue;
        const next = sibling.getBoundingClientRect();
        if (
          Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1 &&
          Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1
        )
          failures.push('overlap: ' + el.getAttribute('aria-label'));
      }
    }
    for (const el of document.querySelectorAll('[dir=auto]')) {
      const box = el.getBoundingClientRect();
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        // RN Web preserves trailing spaces at a wrap. Only measure printed characters.
        for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
          const range = document.createRange();
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          if (
            Array.from(range.getClientRects()).some(
              (line) =>
                line.left < Math.max(0, box.left) - 1 ||
                line.right > Math.min(width, box.right) + 1 ||
                line.top < box.top - 1 ||
                line.bottom > box.bottom + 1,
            )
          )
            failures.push('text: ' + word[0]);
        }
      }
    }
    return failures;
  }, viewport.width);
  expect(issues).toEqual([]);
}

async function expectFieldError(field: Locator, message: string) {
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription('! ' + message);
  const alert = field.locator('..').getByRole('alert');
  await expect(alert).toHaveText('! ' + message);
  await alert.scrollIntoViewIfNeeded();
  await expect(alert).toBeInViewport({ ratio: 1 });
}

for (const [locale, t] of Object.entries({ en, uk, ru })) {
  test.describe(locale, () => {
    test.use({ viewport, locale, isMobile: true });
    test('salon setup, profile, permissions and booking links at 130% text size', async ({
      page,
      browser,
      request,
    }) => {
      const run = locale + '-' + Date.now().toString(36);
      const email = 'specialist.' + 'k'.repeat(36) + '.' + run + '@example.com';
      const salonName = 'Studio' + 'LongSalonName'.repeat(4) + run;
      const owner = await registerOwner(request, 'ay-owner-' + run + '@example.com');
      const app = await serveApp('mobile-business');
      const staff = await browser.newPage({
        viewport,
        locale,
        isMobile: true,
        extraHTTPHeaders: freshAddress(),
      });
      const more = (p: Page) => p.getByRole('tab', { name: t.navigation.more, exact: true });
      try {
        await page.addInitScript(
          (token) => localStorage.setItem('beauty.business.refreshToken', token),
          owner.refreshToken,
        );
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await button(page, t.salons.create).click();
        await enlargeText(page, t.newSalon.title);

        const create = button(page, t.newSalon.create);
        const company = page.getByLabel(t.newSalon.orgName, { exact: true });
        await create.click();
        await expectFieldError(company, t.newSalon.badOrgName);
        await expectLayout(page);
        await company.fill(salonName);
        await page.getByLabel(t.salon.address, { exact: true }).fill('Bema 91');
        await page.getByLabel(t.salon.city, { exact: true }).fill('Warszawa');
        const postal = page.getByLabel(t.salon.postalCode, { exact: true });
        await postal.fill('123');
        await create.click();
        await expectFieldError(postal, t.newSalon.badPostalCodePl);
        await expectLayout(page);
        await postal.fill('01-233');
        await expect(page.getByRole('alert')).toHaveCount(0);
        const locationResult = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().endsWith('/locations'),
        );
        await create.click();
        const response = await locationResult;
        expect(response.ok()).toBe(true);
        const { id, slug } = await response.json();
        const locations = new URL(response.url()).pathname;
        const org = locations.slice(0, -'/locations'.length);
        const headers = { Authorization: 'Bearer ' + owner.accessToken };
        const profile = await request.post(locations + '/' + id + '/staff', {
          headers,
          data: { displayName: email, languages: ['pl'] },
        });
        await expect(profile).toBeOK();
        await expect(
          await request.post(org + '/invitations', {
            headers,
            data: {
              email,
              role: 'staff',
              locationIds: [id],
              staffMemberId: (await profile.json()).id,
            },
          }),
        ).toBeOK();

        await staff.goto(app.url);
        await staff.getByLabel(t.signIn.contact).fill(email);
        await button(staff, t.signIn.sendCode).click();
        const code = await waitForEmail(email, /Sign-in code|Код вход[ау]/);
        await staff
          .getByLabel(t.signIn.code, { exact: true })
          .fill(/\b(\d{6})\b/.exec(code.text)![1]!);
        await button(staff, t.signIn.confirm).click();
        await more(staff).click();
        await button(staff, t.profile.open).click();
        await enlargeText(staff, t.profile.title);
        await expect(staff.getByText(email, { exact: true })).toBeVisible();
        const languages = staff.getByRole('group', { name: t.profile.languages });
        const english = languages.getByRole('checkbox', { name: 'English' });
        await english.click();
        await staff.route('**/staff/*/languages', (route) => route.abort(), { times: 1 });
        const save = button(staff, t.profile.save);
        await save.click();
        await expect(languages).toHaveAccessibleDescription('! ' + t.error.network);
        await expect(staff.getByRole('alert')).toHaveText('! ' + t.error.network);
        await expect(english).toBeChecked();
        await expectLayout(staff);
        await save.click();
        await expect(staff.getByText(t.profile.saved)).toBeVisible();

        await more(page).click();
        await button(page, t.team.open).click();
        await button(page, t.rights.open).click();
        await button(page, t.rights.addCategory).click();
        await button(page, t.rights.save).click();
        const name = page.getByLabel(t.rights.categoryName, { exact: true });
        await expectFieldError(name, t.rights.noName);
        await expectLayout(page);
        await name.fill('Senior');
        await expect(page.getByRole('alert')).toHaveCount(0);
        const contacts = page.getByRole('checkbox', { name: t.rights.names.viewClientContacts });
        await contacts.click();
        await expect(contacts).toBeChecked();
        await expectLayout(page);
        await button(page, t.rights.save).click();
        await expect(page.getByText(t.rights.categorySaved)).toBeVisible();
        await button(page, t.rights.change + ': ' + email).click();
        await button(page, 'Senior').click();
        const key = t.rights.names.viewOwnEarnings;
        const group = page.getByRole('radiogroup', { name: key });
        const allow = group.getByRole('radio', { name: key + ': ' + t.rights.allow });
        await allow.click();
        await expect(allow).toBeChecked();
        await expectLayout(page);
        await button(page, t.rights.save).click();
        await expect(page.getByText(t.rights.saved)).toBeVisible();
        await button(page, t.rights.back).click();
        await button(page, t.team.back).click();
        if ((await more(page).getAttribute('aria-selected')) !== 'true') await more(page).click();
        await button(page, t.bookingLink.open).click();
        await expect(page.getByText(new RegExp('/' + locale + '/b/' + slug + '$'))).toBeVisible();
        await expect(page.getByText(/^<script /)).toContainText(slug);
        await button(page, email).click();
        await expect(page.getByTestId('staff-qr')).toBeVisible();
        await expectLayout(page);
      } finally {
        await staff.close();
        app.server.close();
      }
    });
  });
}
