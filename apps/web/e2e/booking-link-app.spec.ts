import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

/**
 * Task 152: "Link do rezerwacji" in the business app (web preview of apps/mobile-business).
 * The owner sees the salon's booking link, a hint while online booking is off, and copies the
 * link (this browser has no share menu). Screenshot 152.
 * Task 354: below it the salon's QR code with the short link. Screenshot 354.
 * Task 355: the short link and the booking button code for the salon's website, copied.
 * Screenshot 355.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `booking-link-app-${run}@example.com`;
const salonName = `Salon ${'Rezerwacja'.repeat(5)} ${run}`;
const staffName = 'Aleksandra ' + 'Kowalska'.repeat(5);
const PHONE = { width: 320, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function expectWrapped(text: Locator) {
  await expect(text).toBeVisible();
  const lines = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = element.getBoundingClientRect();
    return Array.from(
      range.getClientRects(),
      (line) =>
        line.left >= Math.max(0, box.left) - 1 &&
        line.right <= Math.min(window.innerWidth, box.right) + 1 &&
        line.bottom <= box.bottom + 1,
    );
  });
  expect(lines.length).toBeGreaterThan(1);
  expect(lines).not.toContain(false);
}

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the owner shares the booking link from the business app (task 152)', async ({
  browser,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const verify = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(verify.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: salonName,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );

  await json(
    await request.post(`/v1/organizations/${org.id}/locations/${location.id}/staff`, {
      headers: owner,
      data: { displayName: staffName },
    }),
  );

  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    // The code sign-in comes from an address of its own too (sign-in limits are per address).
    extraHTTPHeaders: freshAddress(),
  });
  // No share menu in this browser: the link goes to the clipboard.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
  });
  const businessApp = await serveApp('mobile-business');
  try {
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await openBusinessMenu(app, 'Link do rezerwacji');
    // 21 px is just over 130% of the 16 px booking link.
    await app.addStyleTag({
      content: '[dir="auto"]:not([role="heading"]) { font-size: 21px !important }',
    });
    await expect(app.getByRole('heading', { name: 'Link do rezerwacji' })).toBeVisible();
    const longLink = app.getByText(new RegExp(`/pl/b/${location.slug}$`));
    await expect(longLink).toHaveCSS('font-size', '21px');
    await expectWrapped(longLink);
    await expect(app.getByText(/Rezerwacja online jest wyłączona/)).toBeVisible();
    await app.getByRole('button', { name: `Udostępnij link: ${salonName}`, exact: true }).click();
    await expect(app.getByText('Link skopiowany.')).toBeVisible();
    const copied = await app.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`/pl/b/${location.slug}$`));
    await shot(app, '152-business-app-booking-link');

    // Task 354: the QR code of the short link, drawn module by module.
    const qr = app.getByRole('img', { name: 'Kod QR rezerwacji', exact: true });
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box!.width).toBeGreaterThan(150);
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
    await expect(app.getByText('Zeskanuj i umów wizytę')).toBeVisible();
    // The caption under the code (the short link card above shows the same link with https://).
    await expect(app.getByText(new RegExp(`/s/${location.slug}$`)).last()).toBeVisible();
    await shot(app, '354-business-app-salon-qr');

    // Task 355: the short link and the website button code.
    await expect(app.getByRole('heading', { name: 'Krótki link' })).toBeVisible();
    await app
      .getByRole('button', { name: `Udostępnij krótki link: ${salonName}`, exact: true })
      .click();
    await expect(app.getByText('Link skopiowany.')).toHaveCount(2);
    expect(await app.evaluate(() => navigator.clipboard.readText())).toMatch(
      new RegExp(`/s/${location.slug}$`),
    );
    const copyCode = app.getByRole('button', {
      name: 'Skopiuj kod: Przycisk rezerwacji na Twoją stronę',
      exact: true,
    });
    await copyCode.scrollIntoViewIfNeeded();
    await copyCode.click();
    await expect(app.getByText('Kod skopiowany.')).toBeVisible();
    const code = await app.evaluate(() => navigator.clipboard.readText());
    expect(code).toContain(`data-salon="${location.slug}"`);
    expect(code).toContain('data-lang="pl"');
    expect(code).toMatch(/^<script src="[^"]+\/embed\.js"/);
    await shot(app, '355-business-app-website-button');

    const specialist = app.getByRole('button', { name: staffName, exact: true });
    await expectWrapped(specialist.getByText(staffName));
    await specialist.click();
    await expect(specialist).toHaveAttribute('aria-pressed', 'true');
    const staffQr = app.getByRole('img', { name: `Kod QR rezerwacji u ${staffName}` });
    await expect(staffQr).toBeVisible();
    for (const image of [qr, staffQr]) {
      const bounds = await image.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(PHONE.width);
      expect(bounds!.height).toBe(bounds!.width);
    }
    const shareStaff = app
      .getByRole('group', { name: staffName, exact: true })
      .getByRole('button', { name: 'Udostępnij link specjalisty', exact: true });
    await shareStaff.click();
    expect(await app.evaluate(() => navigator.clipboard.readText())).toContain(
      `/s/${location.slug}?utm_source=qr&staff=`,
    );
    for (const button of await app.getByRole('button').all()) {
      const bounds = await button.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await app.getByRole('button', { name: staffName }).click();
    await expect(staffQr).toHaveCount(0);
  } finally {
    businessApp.server.close();
    await context.close();
  }
});
