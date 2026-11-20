import { readFile } from 'node:fs/promises';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task Q2 (part 3): the QR code of each specialist. The owner picks a specialist in the cabinet's
 * "Instagram i Twoja strona" and gets their code (PNG / SVG / print) whose link carries
 * `utm_source=qr&staff=…`; the same in the business app's "Link do rezerwacji". A client who
 * scans it sees "Umawiasz się do: Kasia" and, after choosing a service, Kasia's free times at once.
 * Screenshots Q2-staff-qr-cabinet, Q2-staff-qr-booking, Q2-staff-qr-app.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Kod Specjalisty ${run}`;
const OWNER = `staff-qr-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

interface Salon {
  slug: string;
  kasia: string;
  marek: string;
}

async function onlineSalon(api: APIRequestContext): Promise<Salon> {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: NAME,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const cut = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const beard = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Trymowanie brody', durationMinutes: 30, priceGrosze: 6000 },
    }),
  );
  const kasia = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [cut.id] },
    }),
  );
  const marek = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [cut.id, beard.id] },
    }),
  );
  return { slug: location.slug, kasia: kasia.id, marek: marek.id };
}

async function signInCabinet(page: Page) {
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page).toHaveURL(/\/pl\/app/);
}

test('each specialist has a QR code; scanning it books with them (task Q2)', async ({
  browser,
  request,
}) => {
  const salon = await onlineSalon(request);

  // ── The cabinet: a specialist's code next to the salon's one ──────────
  // Its own address: sign-in limits are per address, and the later tests sign in too.
  const desk = await browser.newContext({ locale: 'pl-PL', extraHTTPHeaders: freshAddress() });
  const page = await desk.newPage();
  await signInCabinet(page);
  await page.goto('/pl/app/settings');
  const staffQr = page.getByTestId('staff-qr');
  await staffQr.scrollIntoViewIfNeeded();
  await expect(staffQr.getByText('Kod QR specjalisty')).toBeVisible();
  await staffQr.getByRole('button', { name: 'Kasia' }).click();
  const code = page.getByRole('img', { name: 'Kod QR rezerwacji u Kasia' });
  await expect(code).toBeVisible();
  const kasiaLink = new RegExp(`/s/${salon.slug}\\?utm_source=qr&staff=${salon.kasia}$`);
  await expect(code.locator('svg title')).toHaveText(kasiaLink);
  await expect(staffQr.locator('.qr-print figcaption')).toContainText('Kasia');
  await shot(page, 'Q2-staff-qr-cabinet');
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    staffQr.getByRole('button', { name: 'Pobierz PNG' }).click(),
  ]);
  expect(png.suggestedFilename()).toBe(`qr-${salon.slug}-kasia.png`);
  const [svgFile] = await Promise.all([
    page.waitForEvent('download'),
    staffQr.getByRole('button', { name: 'Pobierz SVG' }).click(),
  ]);
  expect(svgFile.suggestedFilename()).toBe(`qr-${salon.slug}-kasia.svg`);
  expect(await readFile(await svgFile.path(), 'utf8')).toContain(
    `utm_source=qr&#38;staff=${salon.kasia}</title>`,
  );
  // Another specialist: their own code; the same one again hides it.
  await staffQr.getByRole('button', { name: 'Marek' }).click();
  await expect(page.getByRole('img', { name: 'Kod QR rezerwacji u Marek' })).toBeVisible();
  await expect(code).toHaveCount(0);
  await staffQr.getByRole('button', { name: 'Marek' }).click();
  await expect(page.getByRole('img', { name: 'Kod QR rezerwacji u Marek' })).toHaveCount(0);
  await desk.close();

  // ── The client scans Kasia's code ─────────────────────────────────────
  const phone = await browser.newContext({ viewport: PHONE, isMobile: true, locale: 'pl-PL' });
  try {
    const client = await phone.newPage();
    await client.goto(`/s/${salon.slug}?utm_source=qr&staff=${salon.kasia}`);
    await expect(client.getByRole('heading', { name: NAME })).toBeVisible();
    const banner = client.getByTestId('qr-staff');
    await expect(banner).toContainText('Umawiasz się do: Kasia');
    await shot(client, 'Q2-staff-qr-booking');
    // A service Kasia does: straight to her times, no "who" step.
    await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
    await expect(client.locator('.progress [aria-current="step"]')).toHaveText('Termin');
    await expect(client.getByRole('button', { name: /Kasia/ })).toHaveCount(0);
    // Back to the services: "Inny specjalista" and the usual choice.
    await client.goto(`/s/${salon.slug}?utm_source=qr&staff=${salon.kasia}`);
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Inny specjalista' }).click();
    await expect(banner).toHaveCount(0);
    await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
    await expect(client.locator('.progress [aria-current="step"]')).toHaveText('Specjalista');
    await expect(client.getByRole('button', { name: /Kasia/ })).toBeVisible();
    await expect(client.getByRole('button', { name: /Marek/ })).toBeVisible();
    // A service Kasia does not do: the usual choice of who does it.
    await client.goto(`/s/${salon.slug}?utm_source=qr&staff=${salon.kasia}`);
    await client.getByRole('button', { name: /Trymowanie brody/ }).click();
    await expect(client.locator('.progress [aria-current="step"]')).toHaveText('Specjalista');
    await expect(client.getByRole('button', { name: /Marek/ })).toBeVisible();
  } finally {
    await phone.close();
  }

  // ── The business app: the same codes in "Link do rezerwacji" ─────────
  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    extraHTTPHeaders: freshAddress(),
  });
  // No share menu in this browser: the specialist's link goes to the clipboard.
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
    const title = app.getByRole('heading', { name: 'Kod QR specjalisty' });
    await title.scrollIntoViewIfNeeded();
    await expect(title).toBeVisible();
    await app.getByRole('button', { name: 'Kasia' }).click();
    const qr = app.getByRole('img', { name: 'Kod QR rezerwacji u Kasia' });
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box!.width).toBeGreaterThan(150);
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
    await expect(app.getByText('Kasia', { exact: true }).last()).toBeVisible();
    await shot(app, 'Q2-staff-qr-app');
    // "Share the specialist's link": the same link as the code.
    await app.getByRole('button', { name: 'Udostępnij link specjalisty' }).click();
    await expect(app.getByText('Link skopiowany.')).toBeVisible();
    expect(await app.evaluate(() => navigator.clipboard.readText())).toMatch(kasiaLink);
    await app.getByRole('button', { name: 'Kasia' }).click();
    await expect(qr).toHaveCount(0);
  } finally {
    await context.close();
    businessApp.server.close();
  }
});
