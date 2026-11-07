import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * "Raporty" in the cabinet (task 14): the owner sees revenue, the average ticket, visits that
 * took place, no-shows, clients and the split by specialist, service and day for a period.
 * Screenshots 74 (computer) and 74b (phone) go to e2e/screenshots.
 * "Pobierz CSV" downloads every visit of the period for the accountant (task 30).
 * The same report in the business app for iPhone and Android (task 15; its web preview): 75.
 * "Obłożenie" — how busy each specialist was against their schedule (task 141): 74d, app 75c.
 * "Oceny klientów" — the reviews of the period by stars and specialist (task 213): 74e, app 75d.
 * "Tydzień" in the business app — the week at a glance, a tap opens the day (task 214): 75e.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `reports-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Visits can't be booked in the past: book for tomorrow and move two days back in the database. */
function moveToThePast(appointmentId: string) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${appointmentId}'`,
  ]);
}

/** Task 213: a client's review of a visit, written straight into the database. */
function review(appointmentId: string, rating: number) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `INSERT INTO visit_review (id, appointment_id, location_id, staff_id, rating, updated_at) SELECT gen_random_uuid(), id, location_id, staff_id, ${rating}, now() FROM appointment WHERE id = '${appointmentId}'`,
  ]);
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

async function signIn(page: Page, email: string) {
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
}

test('the owner opens "Raporty": revenue, visits, clients, specialists, services, days', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
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
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const services: string[] = [];
  for (const [name, priceGrosze] of [
    ['Strzyżenie męskie', 9000],
    ['Broda', 6000],
  ] as const) {
    services.push(
      (
        await json<{ id: string }>(
          await request.post(`${base}/services`, {
            headers: owner,
            data: { name, durationMinutes: 45, priceGrosze, bufferMinutes: 0 },
          }),
        )
      ).id,
    );
  }
  const staff: string[] = [];
  for (const displayName of ['Ilian', 'Marek']) {
    staff.push(
      (
        await json<{ id: string }>(
          await request.post(`${base}/staff`, {
            headers: owner,
            data: { displayName, serviceIds: services },
          }),
        )
      ).id,
    );
  }
  // Both work 08:00–20:00 every day, so "Obłożenie" has working hours to compare with (task 141).
  for (const id of staff) {
    await json(
      await request.put(`${base}/staff/${id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '08:00', end: '20:00' }],
          })),
        },
      }),
    );
  }

  // Yesterday: Ilian — haircut (paid) and beard (paid), Marek — haircut (paid), one no-show.
  const tomorrow = new Date(Date.now() + 86_400_000);
  // Reviews (task 213): Ilian 5 and 4 stars, Marek 5.
  const visits = [
    { staff: 0, service: 0, email: 'jan', outcome: 'paid', rating: 5 },
    { staff: 0, service: 1, email: 'jan', outcome: 'paid', rating: 4 },
    { staff: 1, service: 0, email: 'piotr', outcome: 'paid', rating: 5 },
    { staff: 1, service: 1, email: 'adam', outcome: 'no_show', rating: 0 },
  ] as const;
  for (const [i, v] of visits.entries()) {
    const start = new Date(
      Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 8 + i),
    );
    const booked = await json<{ id: string; version: number }>(
      await request.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId: services[v.service],
          staffId: staff[v.staff],
          start: start.toISOString(),
          allowOutsideHours: true,
          customer: {
            name: v.email[0]!.toUpperCase() + v.email.slice(1),
            phone: `+4860000010${['jan', 'piotr', 'adam'].indexOf(v.email)}`,
            email: `${v.email}-${run}@example.com`,
          },
        },
      }),
    );
    moveToThePast(booked.id);
    if (v.rating) review(booked.id, v.rating);
    const marked = await json<{ version: number }>(
      await request.post(`${base}/appointments/${booked.id}/status`, {
        headers: owner,
        data: {
          version: booked.version,
          status: v.outcome === 'paid' ? 'completed' : 'no_show',
        },
      }),
    );
    if (v.outcome === 'paid') {
      await json(
        await request.post(`${base}/appointments/${booked.id}/payment`, {
          headers: owner,
          data: { version: marked.version, paid: true },
        }),
      );
    }
  }

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await expect(page.getByRole('heading', { name: 'Raporty' })).toBeVisible();
  // "Last 30 days" always holds yesterday (this month does not on the 1st).
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const totals = page.getByTestId('report-totals');
  await expect(totals.getByText('opłacone wizyty: 3')).toBeVisible();
  await expect(totals.getByText(/240,00\s*zł/)).toBeVisible();
  await expect(totals.getByText(/80,00\s*zł/)).toBeVisible();
  await expect(totals.getByText('nowi: 2')).toBeVisible();
  const byStaff = page.getByRole('table').first();
  await expect(byStaff.getByRole('row').nth(1)).toContainText('Ilian');
  await expect(byStaff.getByRole('row').nth(1)).toContainText(/150,00\s*zł/);
  await expect(byStaff.getByRole('row').nth(2)).toContainText('Marek');
  await expect(page.getByRole('heading', { name: 'Dzień po dniu' })).toBeVisible();
  // Monday to Sunday, and the days before the period to compare with (task 31).
  await expect(page.getByRole('heading', { name: 'Dni tygodnia' })).toBeVisible();
  await expect(page.getByText(/w porównaniu z tyloma samymi dniami wcześniej/)).toBeVisible();
  await shot(page, '74-owner-reports');
  await page.getByRole('heading', { name: 'Dni tygodnia' }).scrollIntoViewIfNeeded();
  await shot(page, '74c-owner-reports-weekdays');
  // "Obłożenie": 1.5 h of visits out of 30 days × 12 h for each specialist (task 141).
  const occupancy = page.getByTestId('report-occupancy');
  await occupancy.scrollIntoViewIfNeeded();
  await expect(occupancy.getByRole('heading', { name: /^Obłożenie: \d+%$/ })).toBeVisible();
  await expect(occupancy.getByRole('listitem').filter({ hasText: 'Ilian' })).toContainText(
    'zajęte 1,5 z 360 godz.',
  );
  await expect(occupancy.getByRole('listitem').filter({ hasText: 'Marek' })).toContainText(
    'zajęte 1,5 z 360 godz.',
  );
  await shot(page, '74d-owner-reports-occupancy');
  // "Oceny klientów": 3 reviews, ★ 4,7; Marek 5,0 first, then Ilian 4,5 (task 213).
  const ratings = page.getByTestId('report-ratings');
  await ratings.scrollIntoViewIfNeeded();
  await expect(ratings.getByRole('heading', { name: 'Oceny klientów: ★ 4,7' })).toBeVisible();
  await expect(ratings.getByText('opinie: 3', { exact: true })).toBeVisible();
  await expect(ratings.getByRole('meter', { name: '5 ★' })).toHaveAttribute('aria-valuenow', '2');
  await expect(ratings.getByRole('listitem').filter({ hasText: 'Marek' })).toContainText(
    '5,0 ★ · opinie: 1',
  );
  await expect(ratings.getByRole('listitem').filter({ hasText: 'Ilian' })).toContainText(
    '4,5 ★ · opinie: 2',
  );
  await shot(page, '74e-owner-reports-ratings');

  // "Pobierz CSV": every visit of the period for the accountant, no client contacts (task 30).
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Pobierz CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^visits-.+\.csv$/);
  const file = readFileSync((await download.path())!, 'utf8');
  expect(file).toContain('Data;Godzina;Specjalista;Usługa;Klient;Status');
  expect(file).toContain(';Ilian;Strzyżenie męskie;Jan;Odbyła się;Salon;90,00;0,00;90,00;tak');
  expect(file).toContain(';Marek;Broda;Adam;Nie przyszedł;');
  expect(file).not.toContain('@example.com');

  await page.setViewportSize(PHONE);
  await page.getByRole('button', { name: 'Ten miesiąc' }).click();
  await page.getByRole('button', { name: 'Własny okres' }).click();
  await expect(page.getByLabel('Od')).toBeVisible();
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  await expect(totals.getByText('opłacone wizyty: 3')).toBeVisible();
  await shot(page, '74b-owner-reports-phone');
  await context.close();

  // ── Business app (web preview of apps/mobile-business): "Raporty" next to the calendar ──
  const businessApp = await serveApp('mobile-business');
  try {
    const app = await (
      await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true })
    ).newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await app.getByRole('button', { name: 'Raporty' }).click();
    await expect(app.getByRole('heading', { name: 'Raporty' })).toBeVisible();
    await app.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    await expect(app.getByText('opłacone wizyty: 3')).toBeVisible();
    await expect(app.getByText(/240,00\s*zł/)).toBeVisible();
    await expect(app.getByText('Ilian').first()).toBeVisible();
    await expect(app.getByText(/150,00\s*zł/)).toBeVisible();
    await shot(app, '75-business-app-reports');
    // Monday to Sunday in the app too (task 32).
    await app.getByText('Dni tygodnia').scrollIntoViewIfNeeded();
    await expect(app.getByText('poniedziałek', { exact: true })).toBeVisible();
    await shot(app, '75b-business-app-reports-weekdays');
    // "Obłożenie" in the app too (task 141).
    await app.getByText(/^Obłożenie: \d+%$/).scrollIntoViewIfNeeded();
    await expect(app.getByText('zajęte 1,5 z 360 godz.').first()).toBeVisible();
    await shot(app, '75c-business-app-reports-occupancy');
    // "Oceny klientów" in the app too (task 213).
    await app.getByText('Oceny klientów: ★ 4,7').scrollIntoViewIfNeeded();
    await expect(app.getByText('4,5 ★ · opinie: 2')).toBeVisible();
    await expect(app.getByText('5,0 ★ · opinie: 1')).toBeVisible();
    await shot(app, '75d-business-app-reports-ratings');
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    // "Tydzień" (task 214): the visits' day shows 4 visits and both specialists at work.
    const visitDay = new Intl.DateTimeFormat('pl-PL', {
      timeZone: 'Europe/Warsaw',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(
      new Date(
        Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 8) -
          2 * 86_400_000,
      ),
    );
    await app.getByRole('button', { name: 'Tydzień' }).click();
    await expect(app.getByRole('heading', { name: 'Tydzień' })).toBeVisible();
    await expect(app.getByText(/^Wizyty w tygodniu: \d+$/)).toBeVisible();
    const dayCard = app.getByRole('button', { name: new RegExp(`^${visitDay}( · dziś)?: `) });
    // On a Monday the visits' day is in the week before.
    if (!(await dayCard.isVisible())) {
      await app.getByRole('button', { name: 'Poprzedni tydzień' }).click();
    }
    await expect(dayCard).toBeVisible();
    await expect(dayCard).toContainText('wizyty: 4');
    await expect(dayCard).toContainText('pracują: 2');
    await shot(app, '75e-business-app-week');
    await dayCard.click();
    await expect(app.getByRole('heading', { name: visitDay })).toBeVisible();
    await expect(app.getByText('Wizyty (4)')).toBeVisible();
  } finally {
    businessApp.server.close();
  }
});
