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
 * Task 161b: "Ochrona przed odwołaniami" with "the salon confirms". A client who did not come
 * books online: the time is held, the page says the salon will confirm, the salon gets an
 * email; in the calendar the visit waits ("⏳"), the owner accepts it and the client gets the
 * usual confirmation. Part 4: the business app shows the same visit with "⏳" and "Przyjmij
 * rezerwację". Screenshots 161–161d.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `guard-owner-${run}@example.com`;
const OLA = `guard-ola-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('a client marked for approval books online and waits until the salon accepts the visit', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Ochrona',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  await json(
    await request.patch(base, {
      headers: owner,
      data: {
        version: location.version,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin rezerwacji\n\nRezerwacja jest bezpłatna.',
        privacyPolicy: '# Polityka prywatności\n\nAdministratorem danych jest GESTALT.',
      },
    }),
  );
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '00:00', end: '24:00' }],
        })),
      },
    }),
  );

  // Ola did not come yesterday.
  const yesterday = new Date(Date.now() - 86_400_000);
  yesterday.setUTCMinutes(0, 0, 0);
  const missed = await json<{ id: string; version: number }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: yesterday.toISOString(),
        allowOutsideHours: true,
        alreadyHappened: true,
        customer: { name: 'Ola Nowak', phone: '+48600300400', email: OLA },
      },
    }),
  );
  await json(
    await request.post(`${base}/appointments/${missed.id}/status`, {
      headers: owner,
      data: { version: missed.version, status: 'no_show' },
    }),
  );
  // One no-show is enough: online bookings of such clients wait for the salon.
  await json(
    await request.put(`${base}/cancellation-guard`, {
      headers: owner,
      data: {
        version: 0,
        enabled: true,
        maxChanges: null,
        windowHours: 720,
        lateCancelMinutes: null,
        maxNoShows: 1,
        action: 'approval',
      },
    }),
  );

  // ── Ola books on her phone ─────────────────────────────────────────────
  // Holds, codes and sign-ins are limited per address: each browser comes from one of its own.
  const phone = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    extraHTTPHeaders: freshAddress(),
  });
  const client = await phone.newPage();
  await client.goto(`/pl/b/${location.slug}`);
  await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await client.getByRole('button', { name: /Kasia/ }).click();
  await expect(client.locator('.times button').first()).toBeVisible();
  await client.locator('.times button').first().click();
  await expect(client.getByText(/Termin czeka na Ciebie/)).toBeVisible();
  await client.getByLabel('Imię i nazwisko').fill('Ola Nowak');
  await client.getByLabel('Telefon').fill('600 300 400');
  await client.getByLabel('E-mail').fill(OLA);
  await client.getByLabel(/Akceptuję regulamin rezerwacji/).check();
  await client.getByRole('button', { name: 'Wyślij kod' }).click();
  const codeMail = await waitForEmail(OLA, /Kod potwierdzenia/);
  await client.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(codeMail.text)![1]!);
  await client.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(client.getByRole('heading', { name: 'Rezerwacja wysłana' })).toBeVisible();
  await expect(client.getByText(/Salon potwierdzi wizytę/)).toBeVisible();
  await shot(client, '161-client-booking-waits-for-salon');
  await waitForEmail(OLA, /Rezerwacja czeka na potwierdzenie salonu/);
  await waitForEmail(OWNER, /Rezerwacja do potwierdzenia/);

  // The link from the page shows the visit waiting.
  const manage = client.getByRole('link', { name: 'Zmień lub odwołaj wizytę' });
  const manageHref = await manage.getAttribute('href');
  await client.goto(manageHref!);
  await expect(client.getByText(/Czeka na potwierdzenie salonu/)).toBeVisible();
  await shot(client, '161a-client-visit-link-waiting');
  await phone.close();

  // ── The owner accepts it in the calendar ───────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const visits = await json<{ id: string; date: string; awaitingApproval: boolean }[]>(
    await request.get(`${base}/appointments`, {
      headers: owner,
      params: { from: today, to: inTwoWeeks },
    }),
  );
  const waiting = visits.find((v) => v.awaitingApproval);
  expect(waiting, 'the visit that waits').toBeTruthy();

  // ── Part 4: the business app (web preview of apps/mobile-business) ─────
  const businessApp = await serveApp('mobile-business');
  const pocket = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  try {
    const app = await pocket.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const salonToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
      new Date(),
    );
    // The first free time can be after midnight.
    if (waiting!.date !== salonToday) {
      await app.getByRole('button', { name: 'Następny dzień' }).first().click();
    }
    const row = app.getByRole('button', { name: /⏳ Ola Nowak/ });
    await expect(row).toBeVisible();
    await shot(app, '161c-business-app-day-waiting');
    await row.click();
    await expect(app.getByText('⏳ Czeka na potwierdzenie')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Przyjmij rezerwację' })).toBeVisible();
    await shot(app, '161d-business-app-accept');
  } finally {
    businessApp.server.close();
    await pocket.close();
  }

  const desk = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\/calendar/);
  await cabinet.goto(`/pl/app/calendar?date=${waiting!.date}`);
  await cabinet.getByRole('button', { name: /⏳ Ola Nowak/ }).click();
  await expect(cabinet.getByText('⏳ Czeka na potwierdzenie')).toBeVisible();
  await expect(cabinet.getByText(/Ochronie przed odwołaniami/)).toBeVisible();
  await shot(cabinet, '161b-owner-accepts-booking');
  await cabinet.getByRole('button', { name: 'Przyjmij rezerwację' }).click();
  await expect(cabinet.getByText('⏳ Czeka na potwierdzenie')).toHaveCount(0);
  await expect(cabinet.getByRole('button', { name: 'Przyjmij rezerwację' })).toHaveCount(0);
  await expect(cabinet.getByText('Salon przyjął rezerwację')).toBeVisible();
  await desk.close();

  const confirmed = await waitForEmail(OLA, /Wizyta potwierdzona/);
  expect(confirmed.text).toContain('Strzyżenie męskie');
});
