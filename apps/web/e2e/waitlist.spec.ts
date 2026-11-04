import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Task 50: a full day on the booking page — "Powiadom mnie, gdy zwolni się termin". The client
 * joins the waiting list, gets the email with the link, opens it and leaves the list.
 * (That a freed time is emailed once is covered by apps/api/test/waitlist.spec.ts.)
 * Task 50c: the owner sees both waiting clients in the cabinet and removes one.
 * Screenshots go to e2e/screenshots (80–80b, 80c–80d).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `waitlist-owner-${run}@example.com`;
const ANNA = `waitlist-anna-${run}@example.com`;
const BOB = `waitlist-bob-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(await api.post('/v1/auth/register', { data: { email, password: PASSWORD, name } }));
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', { data: { email, password: PASSWORD, clientType: 'mobile' } }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('a full day: the client joins the waiting list and leaves it from the email link', async ({
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
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  // One visit fits a day: 10:00–10:45.
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
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
  const free = await json<{ slots: { start: string; date: string }[] }>(
    await request.get(`/v1/public/locations/${location.slug}/availability`, {
      params: {
        serviceId: service.id,
        from: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
        to: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      },
    }),
  );
  const taken = free.slots[0]!;
  await json(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: taken.start,
        customer: { name: 'Jan Nowak', phone: '+48600000001' },
      },
    }),
  );

  // ── The client: the full day, "tell me when a time becomes free" ───────
  const context = await browser.newContext({ viewport: PHONE, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto(`/pl/b/${location.slug}`);
  await page.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await page.getByRole('button', { name: /Kasia/ }).click();
  await expect(page.locator('.times button').first()).toBeVisible();
  const fullDay = page.locator('.day-strip button.full', {
    has: page.locator('b', { hasText: new RegExp(`^${Number(taken.date.slice(8))}$`) }),
  });
  await fullDay.first().click();
  await expect(page.getByText('Brak wolnych terminów tego dnia.')).toBeVisible();
  await page.getByRole('button', { name: 'Powiadom mnie, gdy zwolni się termin' }).click();
  const form = page.getByRole('form', { name: 'Powiadom mnie, gdy zwolni się termin' });
  await form.getByLabel('Imię i nazwisko').fill('Anna Kowalska');
  await form.getByLabel('E-mail').fill(ANNA);
  await form.getByRole('checkbox').check();
  await shot(page, '80-client-waitlist-form');
  await form.getByRole('button', { name: 'Zapisz mnie na listę' }).click();
  await expect(page.getByText('Jesteś na liście oczekujących.')).toBeVisible();
  await shot(page, '80a-client-waitlist-joined');

  // ── Task 50c: the owner's "Lista oczekujących" ─────────────────────────
  await json(
    await request.post(`/v1/public/locations/${location.slug}/waitlist`, {
      data: {
        serviceId: service.id,
        date: taken.date,
        name: 'Bob Brown',
        email: BOB,
        phone: '+48600222333',
        acceptTerms: true,
      },
    }),
  );
  const desk = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\/calendar/);
  await cabinet.getByRole('link', { name: 'Lista oczekujących' }).first().click();
  await expect(cabinet.getByRole('heading', { name: 'Lista oczekujących' })).toBeVisible();
  await expect(cabinet.getByText('Anna Kowalska')).toBeVisible();
  await expect(cabinet.getByText('Strzyżenie męskie · Kasia')).toBeVisible();
  await expect(cabinet.getByRole('link', { name: ANNA })).toBeVisible();
  await expect(cabinet.getByText('Strzyżenie męskie · dowolny specjalista')).toBeVisible();
  await expect(cabinet.getByRole('link', { name: '+48600222333' })).toBeVisible();
  await shot(cabinet, '80c-owner-waitlist');
  await cabinet.getByRole('button', { name: 'Usuń z listy: Bob Brown' }).click();
  await expect(cabinet.getByText('Usunąć Bob Brown z listy?', { exact: false })).toBeVisible();
  await shot(cabinet, '80d-owner-waitlist-remove');
  await cabinet.getByRole('button', { name: 'Tak, usuń' }).click();
  await expect(cabinet.getByText('Usunięto Bob Brown z listy oczekujących.')).toBeVisible();
  await expect(cabinet.getByText('Bob Brown', { exact: true })).toHaveCount(0);
  await expect(cabinet.getByText('Anna Kowalska')).toBeVisible();
  await desk.close();

  // ── The email's link: what she waits for, and leaving the list ─────────
  const mail = await waitForEmail(ANNA, /Jesteś na liście oczekujących/);
  expect(mail.text).toContain('Strzyżenie męskie u Kasia (Gestalt Barbershop)');
  const link = /https?:\/\/\S+\/pl\/w\/[\w-]+/.exec(mail.text)?.[0];
  expect(link, 'leave link').toBeTruthy();
  await page.goto(new URL(link!).pathname);
  await expect(page.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
  await expect(page.getByText('Czekasz na wolny termin.')).toBeVisible();
  await shot(page, '80b-client-waitlist-link');
  await page.getByRole('button', { name: 'Wypisz mnie z listy' }).click();
  await expect(page.getByText('Nie ma Cię już na liście oczekujących.')).toBeVisible();
  await context.close();
});
