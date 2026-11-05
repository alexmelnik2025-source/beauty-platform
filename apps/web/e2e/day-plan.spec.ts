import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 142: "Drukuj plan dnia". From the calendar the owner opens the day plan for printing:
 * every specialist with their hours, visits by time (service, client, phone, wishes) and blocked
 * time. Screenshots 76p (screen) and 76q (as printed).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `plan-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };
/** The salon's own address: the API limits sign-ups and sign-ins per address. */
const OWNER_IP = freshAddress();

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

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

test('the owner prints the day plan: specialists, visits, clients and blocked time', async ({
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
  const haircut = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff: string[] = [];
  for (const displayName of ['Ilian', 'Marek']) {
    const s = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: { displayName, serviceIds: [haircut.id] },
      }),
    );
    await json(
      await request.put(`${base}/staff/${s.id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '08:00', end: '20:00' }],
          })),
        },
      }),
    );
    staff.push(s.id);
  }

  // Tomorrow: two visits for Ilian, a training block for Marek.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(tomorrow);
  const at = (utcHour: number) =>
    new Date(
      Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), utcHour),
    ).toISOString();
  for (const [i, client] of (
    [
      ['Jan Kowalski', '+48600000201'],
      ['Piotr Nowak', '+48600000202'],
    ] as const
  ).entries()) {
    await json(
      await request.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId: haircut.id,
          staffId: staff[0],
          start: at(8 + i * 2),
          allowOutsideHours: true,
          customer: { name: client[0], phone: client[1], email: `plan-${i}-${run}@example.com` },
        },
      }),
    );
  }
  await json(
    await request.post(`${base}/time-blocks`, {
      headers: owner,
      data: { staffId: staff[1], start: at(11), end: at(13), reason: 'Szkolenie' },
    }),
  );

  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    extraHTTPHeaders: OWNER_IP,
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);

  // The calendar has a print link for the day it shows.
  const link = page.getByRole('link', { name: 'Drukuj plan dnia' });
  await expect(link).toHaveAttribute('href', /\/pl\/app\/calendar\/print\?date=\d{4}-\d{2}-\d{2}$/);

  await page.goto(`/pl/app/calendar/print?date=${day}`);
  await expect(page.getByRole('heading', { name: 'Plan dnia' })).toBeVisible();
  const plan = page.getByTestId('day-plan');
  await expect(plan).toContainText('Gestalt Barbershop');
  const ilian = plan.getByRole('region', { name: 'Ilian' });
  await expect(ilian).toContainText('08:00–20:00');
  await expect(ilian.getByRole('row')).toHaveCount(3);
  await expect(ilian.getByRole('row').nth(1)).toContainText('Jan Kowalski');
  await expect(ilian.getByRole('row').nth(1)).toContainText('Strzyżenie męskie');
  await expect(ilian.getByRole('row').nth(1)).toContainText('pierwsza wizyta');
  await expect(ilian.getByRole('row').nth(2)).toContainText('Piotr Nowak');
  const marek = plan.getByRole('region', { name: 'Marek' });
  await expect(marek).toContainText('Blokada: Szkolenie');
  await expect(page.getByRole('button', { name: 'Drukuj' })).toBeEnabled();
  await shot(page, '76p-day-plan');

  // As it comes out of the printer: only the plan.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'Drukuj' })).toBeHidden();
  await shot(page, '76q-day-plan-printed');
  await page.emulateMedia({ media: 'screen' });

  // The next day is empty.
  await page.getByRole('button', { name: 'Następny dzień' }).click();
  await expect(plan.getByRole('region', { name: 'Ilian' })).toContainText('Brak wizyt.');
  await context.close();
});
