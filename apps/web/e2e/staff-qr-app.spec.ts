import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task Q2 (part 7): a QR code for each specialist in the business app's "Link do rezerwacji"
 * (web preview of apps/mobile-business). Nothing until a name is tapped; then that specialist's
 * code with `?utm_source=qr&staff=…` and "Udostępnij link specjalisty" (copied here — this
 * browser has no share menu). Screenshot Q2-a-business-app-staff-qr.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `staff-qr-app-${run}@example.com`;
const NAME = `Kod Specjalisty App ${run}`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the business app shows a QR code for each specialist (task Q2)', async ({
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
    await request.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: NAME,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  await json(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  const marek = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [service.id] },
    }),
  );
  // A specialist who left is not offered.
  const gone = await json<{ id: string; version: number }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Dawny Pracownik', serviceIds: [] },
    }),
  );
  await json(
    await request.patch(`${base}/staff/${gone.id}`, {
      headers: owner,
      data: { active: false, version: gone.version },
    }),
  );

  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    permissions: ['clipboard-read', 'clipboard-write'],
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

    await app.getByRole('button', { name: 'Link do rezerwacji' }).click();
    await expect(app.getByRole('heading', { name: 'Link do rezerwacji' })).toBeVisible();

    // The names, nobody's code yet; the one who left is not there.
    const section = app.getByRole('group', { name: 'Kod QR specjalisty' });
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole('button', { name: 'Kasia' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Marek' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Dawny Pracownik' })).toHaveCount(0);
    await expect(app.getByTestId('staff-qr')).toHaveCount(0);
    // The salon's own code is still the only one drawn.
    await expect(app.getByRole('img', { name: 'Kod QR rezerwacji' })).toBeVisible();

    // Tap a name: that specialist's code, square and large enough to scan from the screen.
    await section.getByRole('button', { name: 'Marek' }).click();
    const qr = app.getByRole('img', { name: 'Kod QR rezerwacji u Marek' });
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box!.width).toBeGreaterThan(150);
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
    await expect(app.getByText('Marek', { exact: true }).last()).toBeVisible();
    await expect(app.getByText('Zeskanuj i umów wizytę').last()).toBeVisible();
    await shot(app, 'Q2-a-business-app-staff-qr');

    // The link of the code: the salon's QR link plus whose code it is.
    await app.getByRole('button', { name: 'Udostępnij link specjalisty' }).click();
    await expect(app.getByText('Link skopiowany.')).toBeVisible();
    const copied = await app.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`/s/${location.slug}\\?utm_source=qr&staff=${marek.id}$`));

    // Tapping the name again puts the code away.
    await section.getByRole('button', { name: 'Marek' }).click();
    await expect(app.getByTestId('staff-qr')).toHaveCount(0);
  } finally {
    businessApp.server.close();
    await context.close();
  }
});
