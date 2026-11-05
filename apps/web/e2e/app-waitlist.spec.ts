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
 * Task 94: "Lista oczekujących" in the business app (web preview of apps/mobile-business).
 * A full day; two clients wait for it. The owner opens that day in the app, sees both with
 * their contacts, removes one, and books the other with "+ Nowa wizyta" — the form comes
 * filled in with her service, specialist, day, name, phone and email.
 * Screenshots go to e2e/screenshots (88–88c).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-waitlist-owner-${run}@example.com`;
const ANNA = `app-waitlist-anna-${run}@example.com`;
const BOB = `app-waitlist-bob-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// Addresses of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '198.51.100.94' };
const CLIENT_IP = { 'x-forwarded-for': '198.51.100.95' };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: OWNER_IP,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app: the day’s waiting list — remove one client, book the other', async ({
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
        name: 'Gestalt Barbershop',
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
  const kasia = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  // One visit fits a day: 10:00–10:45.
  await json(
    await request.put(`${base}/staff/${kasia.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '10:00', end: '10:45' }],
        })),
      },
    }),
  );
  // The day after tomorrow is full.
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const free = await json<{ slots: { start: string; date: string }[] }>(
    await request.get(`/v1/public/locations/${location.slug}/availability`, {
      params: { serviceId: service.id, from: day, to: day },
    }),
  );
  const taken = free.slots[0]!;
  const jan = await json<{ id: string; version: number }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: kasia.id,
        start: taken.start,
        customer: { name: 'Jan Nowak', phone: '+48600000001' },
      },
    }),
  );
  // Anna waits for Kasia, Bob for anyone.
  for (const [name, email, phone, staffId] of [
    ['Anna Kowalska', ANNA, '+48600111222', kasia.id],
    ['Bob Brown', BOB, '+48600222333', undefined],
  ] as const) {
    await json(
      await request.post(`/v1/public/locations/${location.slug}/waitlist`, {
        headers: CLIENT_IP,
        data: {
          serviceId: service.id,
          staffId,
          date: taken.date,
          name,
          email,
          phone,
          acceptTerms: true,
        },
      }),
    );
  }

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: OWNER_IP,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
      new Date(),
    );
    const daysAhead = Math.round((Date.parse(taken.date) - Date.parse(today)) / 86_400_000);
    for (let i = 0; i < daysAhead; i++) {
      await phone.getByRole('button', { name: 'Następny dzień' }).click();
    }

    // ── The full day: both waiting clients with their contacts ─────────────
    await expect(phone.getByText('Jan Nowak')).toBeVisible();
    await expect(phone.getByText('Lista oczekujących (2)')).toBeVisible();
    await expect(phone.getByText('Anna Kowalska')).toBeVisible();
    // Jan's visit and Anna's wait are both for Kasia.
    await expect(phone.getByText('Strzyżenie męskie · Kasia')).toHaveCount(2);
    await expect(phone.getByText('Strzyżenie męskie · dowolny specjalista')).toBeVisible();
    await expect(phone.getByRole('button', { name: '+48600222333' })).toBeVisible();
    await expect(phone.getByRole('button', { name: ANNA })).toBeVisible();
    await phone.getByText('Lista oczekujących (2)').scrollIntoViewIfNeeded();
    await shot(phone, '88-business-app-waitlist');

    // ── "Usuń z listy": Bob ────────────────────────────────────────────────
    await phone.getByRole('button', { name: 'Usuń z listy: Bob Brown' }).click();
    await expect(phone.getByText('Usunąć Bob Brown z listy?', { exact: false })).toBeVisible();
    await shot(phone, '88a-business-app-waitlist-remove');
    await phone.getByRole('button', { name: 'Tak, usuń' }).click();
    await expect(phone.getByText('Usunięto Bob Brown z listy oczekujących.')).toBeVisible();
    await expect(phone.getByText('Lista oczekujących (1)')).toBeVisible();
    await expect(phone.getByText('Bob Brown', { exact: true })).toHaveCount(0);
    const list = await json<{ items: { name: string }[] }>(
      await request.get(`${base}/waitlist`, { headers: owner, params: { from: taken.date } }),
    );
    expect(list.items.map((e) => e.name)).toEqual(['Anna Kowalska']);

    // Jan cancels, so Kasia's 10:00 is free again.
    await json(
      await request.post(`${base}/appointments/${jan.id}/cancel`, {
        headers: owner,
        data: { version: jan.version, reason: 'Klient odwołał telefonicznie' },
      }),
    );

    // ── "+ Nowa wizyta" for Anna: everything filled in ─────────────────────
    await phone.getByRole('button', { name: 'Nowa wizyta dla: Anna Kowalska' }).click();
    await expect(phone.getByRole('heading', { name: 'Nowa wizyta' })).toBeVisible();
    await expect(phone.getByText('✓ Strzyżenie męskie', { exact: false })).toBeVisible();
    await expect(phone.getByText('✓ Kasia')).toBeVisible();
    await expect(phone.getByLabel('Imię i nazwisko', { exact: true })).toHaveValue('Anna Kowalska');
    await expect(phone.getByLabel('Telefon', { exact: true })).toHaveValue('+48600111222');
    await expect(phone.getByLabel(/^E-mail/)).toHaveValue(ANNA);
    const ten = phone.getByRole('button', { name: '10:00', exact: true });
    await expect(ten).toBeVisible();
    await ten.click();
    await shot(phone, '88b-business-app-waitlist-new-visit');
    await phone.getByRole('button', { name: 'Zapisz wizytę' }).click();
    await expect(phone.getByText('Anna Kowalska').first()).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'Nowa wizyta' })).toHaveCount(0);
    await shot(phone, '88c-business-app-waitlist-booked');
    await context.close();
  } finally {
    businessApp.server.close();
  }

  // The visit is Anna's: the same client card as her waiting-list email.
  const calendar = await json<{
    appointments: { status: string; customer: { name: string } | null }[];
  }>(
    await request.get(`${base}/calendar`, {
      headers: owner,
      params: { from: taken.date, to: taken.date },
    }),
  );
  expect(
    calendar.appointments.filter((a) => a.status === 'confirmed').map((a) => a.customer?.name),
  ).toEqual(['Anna Kowalska']);
});
