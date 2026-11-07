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
 * Task 223: "Umów ponownie" in the business app's visit card (web preview of
 * apps/mobile-business). The owner opens tomorrow's visit, taps "Umów ponownie" and gets the
 * new-visit form with the same client (from the salon's base), service and specialist; picks a
 * time and saves. Screenshot 223-a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `book-again-app-owner-${run}@example.com`;
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

/** The business app's sign-in: email → code from Mailpit → the day calendar. */
async function signInToApp(app: Page, url: string, email: string) {
  await app.goto(url);
  await app.getByLabel('E-mail lub telefon').fill(email);
  await app.getByRole('button', { name: 'Wyślij kod' }).click();
  const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
  await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
  await app.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
}

test('the owner books a client again from the visit card in the business app (task 223)', async ({
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
        name: `Book Again App ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia Nowak', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '20:00' }],
        })),
      },
    }),
  );
  // Tomorrow in Warsaw (the app's "next day"), 09:00 UTC = 10:00 or 11:00 in Warsaw.
  const warsawToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(),
  );
  const tomorrow = new Date(Date.parse(`${warsawToday}T12:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const visit = await json<{ id: string; customer: { id: string } }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: `${tomorrow}T09:00:00.000Z`,
        allowOutsideHours: true,
        customer: {
          name: 'Jan Kowalski',
          phone: '+48600000223',
          email: `book-again-client-${run}@example.com`,
        },
      },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // The code sign-in comes from an address of its own too (sign-in limits are per address).
      extraHTTPHeaders: freshAddress(),
    });
    const app = await context.newPage();
    await signInToApp(app, businessApp.url, OWNER);
    await app.getByRole('button', { name: 'Następny dzień' }).click();
    await app.getByRole('button', { name: /Jan Kowalski · Strzyżenie męskie/ }).click();
    await app.getByRole('button', { name: 'Umów ponownie' }).click();

    // The form starts with the same client, service and specialist, on the visit's day.
    await expect(app.getByRole('heading', { name: 'Nowa wizyta' })).toBeVisible();
    await expect(app.getByText('Jan Kowalski · +48600000223')).toBeVisible();
    await expect(app.getByText(/^Strzyżenie męskie/).first()).toBeVisible();
    await expect(app.getByText(/^Kasia Nowak/).first()).toBeVisible();
    await app.getByRole('button', { name: '15:00', exact: true }).click();
    await shot(app, '223-a-business-app-book-again');
    await app.getByRole('button', { name: 'Zapisz wizytę' }).click();
    await expect(app.getByRole('button', { name: 'Umów ponownie' })).toBeVisible();

    // The new visit is the same client's (by id, no new client in the base).
    const day = await json<{ appointments: { time: string; customer: { id: string } | null }[] }>(
      await request.get(`${base}/calendar`, {
        headers: owner,
        params: { from: tomorrow, to: tomorrow },
      }),
    );
    const again = day.appointments.find((a) => a.time === '15:00');
    expect(again?.customer?.id).toBe(visit.customer.id);
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
