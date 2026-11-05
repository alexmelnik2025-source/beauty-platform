import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 131: "Salon" in the business app (web preview of apps/mobile-business). The owner changes
 * the salon's phone and description from the phone; online booking cannot be switched on
 * without booking terms; when someone else saved the salon meanwhile, the app shows the current
 * data and the second try goes through. Screenshots 131, 131a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `salon-app-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// A sign-up address of its own (reserved for tests, RFC 2544): the API allows 10 sign-ups an hour from one.
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.18.${n >> 8}.${n & 255}` };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the owner changes the salon from the business app (task 131)', async ({
  browser,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: ADDRESS,
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: ADDRESS,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const path = `/v1/organizations/${org.id}/locations/${location.id}`;

  const businessApp = await serveApp('mobile-business');
  try {
    // The app's sign-in from the same address of its own: sign-in codes are limited per address too.
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: ADDRESS,
    });
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    // ── "Salon": phone without the country code, a description ──────────────
    await app.getByRole('button', { name: 'Salon', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Salon', exact: true })).toBeVisible();
    await expect(app.getByLabel('Nazwa salonu')).toHaveValue('Gestalt Barbershop');
    await app.getByLabel('Telefon salonu').fill('22 123 45 67');
    await app.getByLabel('O salonie').fill('Strzyżemy od 2015 roku. Kawa gratis.');
    await shot(app, '131-business-app-salon');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const saved = await json<{ phone: string; description: string; version: number }>(
      await request.get(path, { headers: owner }),
    );
    expect(saved.phone).toBe('+48221234567');
    expect(saved.description).toBe('Strzyżemy od 2015 roku. Kawa gratis.');

    // ── Online booking needs the terms first ────────────────────────────────
    await app.getByLabel('Rezerwacja online').click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText(/potrzebuje regulaminu i polityki prywatności/)).toBeVisible();
    await shot(app, '131a-business-app-salon-terms-needed');

    // Meanwhile the terms are written in the salon dashboard (a newer version of the salon).
    await json(
      await request.patch(path, {
        headers: owner,
        data: {
          version: saved.version,
          bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
          privacyPolicy: '# Prywatność\n\nAdministratorem danych jest GESTALT.',
        },
      }),
    );
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText(/Ktoś inny właśnie zmienił dane salonu/)).toBeVisible();
    await expect(app.getByText('Wyłączona — strona rezerwacji jest niedostępna.')).toBeVisible();
    await app.getByLabel('Rezerwacja online').click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    await expect(app.getByText('Włączona — klienci umawiają się przez link salonu.')).toBeVisible();
    const online = await json<{ onlineBookingEnabled: boolean; phone: string }>(
      await request.get(path, { headers: owner }),
    );
    expect(online).toMatchObject({ onlineBookingEnabled: true, phone: '+48221234567' });

    // ── A new name shows on the calendar at once ────────────────────────────
    await app.getByLabel('Nazwa salonu').fill('Gestalt Barbershop Bema');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(app.getByText('Gestalt Barbershop Bema')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
