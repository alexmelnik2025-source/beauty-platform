import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { pl as t } from '../../mobile-business/src/locales/pl';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const phone = { viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' };
test.use(phone);

async function registerOwner(api: APIRequestContext, email: string) {
  const login = { email, password: 'e2e-password-123' };
  const headers = freshAddress();
  await expect(
    await api.post('/v1/auth/register', {
      headers,
      data: { ...login, name: 'Salon BM' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await api.post('/v1/auth/verify-email', {
      headers,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const response = await api.post('/v1/auth/login', {
    headers,
    data: { ...login, clientType: 'mobile' },
  });
  await expect(response).toBeOK();
  return (await response.json()) as { accessToken: string; refreshToken: string };
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function checkLayout(page: Page) {
  expect(
    await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      // RN Web's ScrollView can hide overflow even when the page itself fits.
      overflowing: Array.from(document.querySelectorAll('div'))
        .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.getAttribute('role') ?? el.tagName),
    })),
  ).toEqual({ viewport: 320, document: 320, overflowing: [] });
  for (const control of await page
    .getByRole('button')
    .or(page.getByRole('checkbox'))
    .or(page.getByRole('textbox'))
    .all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
}

async function checkLabel(input: Locator, label: string) {
  await expect(input).toHaveAccessibleName(label);
  expect(
    await input.evaluate(
      (el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent,
    ),
  ).toBe(label);
}

async function checkError(input: Locator, message: string) {
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAccessibleDescription('! ' + message);
  await expect(input.locator('..').getByRole('alert')).toHaveText('! ' + message);
}

test('salon fields, permission and language checkboxes, and sharing at 320 px with 130% text', async ({
  page,
  browser,
  request,
}) => {
  const run = Date.now().toString(36);
  const salonName = 'Studio' + 'Rezerwacja'.repeat(5) + run;
  const owner = await registerOwner(request, `bm-owner-${run}@example.com`);
  const specialist = await browser.newPage({ ...phone, extraHTTPHeaders: freshAddress() });
  const app = await serveApp('mobile-business');
  try {
    await page.addInitScript(
      (token) => localStorage.setItem('beauty.business.refreshToken', token),
      owner.refreshToken,
    );
    await page.goto(app.url);
    await button(page, t.salons.create).click();
    const heading = page.getByRole('heading', { name: t.newSalon.title });
    const originalSize = await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const largeText = { content: '* { -webkit-text-size-adjust: 130% !important }' };
    await page.addStyleTag(largeText);
    expect(await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(
      originalSize * 1.3,
      1,
    );

    const field = (name: string) => page.getByRole('textbox', { name, exact: true });
    for (const label of [
      t.newSalon.orgName,
      t.newSalon.locationName,
      t.salon.address,
      t.salon.city,
      t.salon.postalCode,
    ]) {
      await checkLabel(field(label), label);
    }
    const company = field(t.newSalon.orgName);
    await expect(company).toHaveAccessibleDescription(t.newSalon.orgNameHint);
    await button(page, t.newSalon.create).click();
    await checkError(company, t.newSalon.badOrgName);
    await company.fill(salonName);
    await expect(company).toHaveAccessibleDescription(t.newSalon.orgNameHint);
    const address = field(t.salon.address);
    await address.fill('ulica ' + 'Konstantynopolitańska'.repeat(5) + ' 91');
    expect(await address.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await field(t.salon.city).fill('Warszawa');
    await field(t.salon.postalCode).fill('01-233');
    await checkLayout(page);
    const created = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/locations'),
    );
    await button(page, t.newSalon.create).click();
    const response = await created;
    expect(response.ok()).toBe(true);
    const { id, slug } = await response.json();
    const locations = new URL(response.url()).pathname;
    const headers = { Authorization: 'Bearer ' + owner.accessToken };
    const staffName = 'Aleksandra Kowalska';
    const staff = await request.post(`${locations}/${id}/staff`, {
      headers,
      data: { displayName: staffName, languages: ['pl'] },
    });
    await expect(staff).toBeOK();
    const email = `bm-staff-${run}@example.com`;
    await expect(
      await request.post(locations.replace(/\/locations$/, '/invitations'), {
        headers,
        data: { email, role: 'staff', locationIds: [id], staffMemberId: (await staff.json()).id },
      }),
    ).toBeOK();

    await openBusinessMenu(page, t.team.open);
    await button(page, t.navigation.more).click();
    await button(page, t.rights.open).click();
    await button(page, t.rights.addCategory).click();
    const category = field(t.rights.categoryName);
    await checkLabel(category, t.rights.categoryName);
    await button(page, t.rights.save).click();
    await checkError(category, t.rights.noName);
    await category.fill('Senior');
    await expect(page.getByRole('alert')).toHaveCount(0);
    const contacts = page.getByRole('checkbox', {
      name: t.rights.names.viewClientContacts,
      exact: true,
    });
    await expect(contacts).not.toBeChecked();
    await contacts.click();
    await expect(contacts).toBeChecked();
    await checkLayout(page);
    await button(page, t.rights.back).click();
    await button(page, t.team.back).click();
    await openBusinessMenu(page, t.bookingLink.open);
    const link = page.getByText(new RegExp('/pl/b/' + slug + '$'));
    await expect(link).toBeVisible();
    expect(
      await link.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      }),
    ).toBeGreaterThan(1);
    const b = t.bookingLink;
    await expect(button(page, b.share + ': ' + salonName)).toBeVisible();
    await expect(button(page, b.shortShare + ': ' + salonName)).toBeVisible();
    await page.context().grantPermissions(['clipboard-write'], { origin: app.url });
    await button(page, b.embedCopy + ': ' + b.embedTitle).click();
    await expect(page.getByRole('status')).toHaveText(b.codeCopied);
    await button(page, staffName).click();
    await expect(
      page
        .getByRole('group', { name: staffName, exact: true })
        .getByRole('button', { name: b.staffQrShare }),
    ).toBeVisible();
    await checkLayout(page);

    // The specialist opens their own profile in a new session.
    await specialist.goto(app.url);
    await specialist.getByLabel(t.signIn.contact).fill(email);
    await button(specialist, t.signIn.sendCode).click();
    const code = await waitForEmail(email, /Kod logowania/);
    await specialist
      .getByLabel(t.signIn.code, { exact: true })
      .fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await button(specialist, t.signIn.confirm).click();
    await openBusinessMenu(specialist, t.profile.open);
    await specialist.addStyleTag(largeText);
    const languages = specialist.getByRole('group', { name: t.profile.languages });
    await expect(languages).toHaveAccessibleDescription(t.profile.languagesHint);
    await expect(languages.getByRole('checkbox', { name: 'Polski' })).toBeChecked();
    const english = languages.getByRole('checkbox', { name: 'English' });
    await english.click();
    await expect(english).toBeChecked();
    await specialist.route('**/staff/*/languages', (route) => route.abort(), { times: 1 });
    const save = button(specialist, t.profile.save);
    await save.click();
    await expect(languages).toHaveAccessibleDescription('! ' + t.error.network);
    await expect(specialist.getByRole('alert')).toHaveText('! ' + t.error.network);
    await checkLayout(specialist);
    await save.click();
    await expect(specialist.getByRole('status')).toHaveText(t.profile.saved);
  } finally {
    await specialist.close();
    app.server.close();
  }
});
