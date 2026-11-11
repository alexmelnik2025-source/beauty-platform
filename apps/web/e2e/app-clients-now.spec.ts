import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 366: "Klienci widzą teraz" on the business app's day screen (web preview of
 * apps/mobile-business). Kasia works around the clock: clients see "Otwarte · do północy".
 * A vacation for today, and after "Odśwież" the owner sees what clients see — closed until
 * tomorrow, "nieczynne" today. Screenshots 366, 366a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-clients-now-${run}@example.com`;
const NAME = `Klienci Widzą ${run}`;
const PHONE = { width: 390, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544).
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.19.${n >> 8}.${n & 255}` };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: ADDRESS,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app: the owner sees the salon as clients see it now', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
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
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
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
  const kasia = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${kasia.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '00:00', end: '24:00' }],
        })),
      },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: ADDRESS,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    const card = phone.getByTestId('clients-now');
    await expect(card.getByLabel('Klienci widzą teraz: Otwarte · do północy')).toBeVisible();
    await expect(card).toContainText('Dziś dla klientów: 00:00–24:00');
    await card.scrollIntoViewIfNeeded();
    await shot(phone, '366-business-app-clients-now');

    // Not on other days: it is about now.
    await phone.getByRole('button', { name: 'Następny dzień' }).click();
    await expect(card).toHaveCount(0);
    await phone.getByRole('button', { name: 'Dziś' }).click();
    await expect(card).toBeVisible();

    // A vacation for the whole of today: after "Odśwież", closed until tomorrow.
    const page = await json<{ todayHours: { date: string } }>(
      await request.get(`/v1/public/locations/${location.slug}`),
    );
    const today = page.todayHours.date;
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    await json(
      await request.post(`${base}/staff/${kasia.id}/time-off`, {
        headers: owner,
        data: { start: `${today}T00:00`, end: `${tomorrow}T00:00`, note: 'Urlop' },
      }),
    );
    await phone.getByRole('button', { name: 'Odśwież' }).click();
    await expect(
      card.getByLabel('Klienci widzą teraz: Zamknięte · otwarcie: jutro, 00:00'),
    ).toBeVisible();
    await expect(card).toContainText('Dziś dla klientów: nieczynne');
    await card.scrollIntoViewIfNeeded();
    await shot(phone, '366a-business-app-clients-now-closed');
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
