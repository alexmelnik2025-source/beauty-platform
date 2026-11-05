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
 * Task 16: the salon's happy hours. The owner sets −20% at Kasia's (via the API); the client
 * sees "−20%" at the free times and the lower price on the held visit. Then the owner manages
 * the rules in the cabinet's "Happy hours" page (part 3). Screenshots 76, 76a, 76b, 76c.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `happy-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithHappyHours(api: APIRequestContext): Promise<string> {
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
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: 'Happy Barber' } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Happy Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Prywatność\n\nAdministratorem danych jest Happy Barber.',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await api.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '21:00' }],
        })),
      },
    }),
  );
  // Every day until noon −20% at Kasia's.
  await json(
    await api.put(`${base}/happy-hours`, {
      headers: owner,
      data: {
        rules: [
          {
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            start: '08:00',
            end: '12:00',
            discountPercent: 20,
            staffIds: [staff.id],
          },
        ],
      },
    }),
  );
  return location.slug;
}

test('the client sees happy-hour prices at the free times and on the held visit', async ({
  browser,
  request,
}) => {
  const slug = await salonWithHappyHours(request);
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    // A client of its own (the API limits holds per address).
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.76' },
  });
  const client = await phone.newPage();
  await client.goto(`/pl/b/${slug}`);
  await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await client.getByRole('button', { name: /Kasia/ }).click();
  // Tomorrow: the whole morning is free (today's may have passed).
  await client.locator('.day-strip button').nth(1).click();
  const morning = client.locator('.times button', { hasText: '09:00' });
  await expect(morning).toContainText('−20%');
  await expect(client.locator('.times button', { hasText: '13:00' })).not.toContainText('%');
  await morning.scrollIntoViewIfNeeded();
  await shot(client, '76-booking-happy-hours');
  await morning.click();
  const summary = client.locator('.summary');
  await expect(summary).toContainText('72,00');
  await expect(summary.locator('s')).toContainText('90,00');
  await expect(summary).toContainText('−20%');
  await shot(client, '76a-booking-happy-hour-price');
  await phone.close();

  // Part 3: the owner sees the rule in the cabinet, adds Tuesday afternoons −15% for one
  // service and removes it again.
  const desk = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
  const owner = await desk.newPage();
  await owner.goto('/pl/login');
  await owner.getByLabel('E-mail').fill(OWNER);
  await owner.getByLabel('Hasło').fill(PASSWORD);
  await owner.getByRole('button', { name: 'Zaloguj się' }).click();
  await owner.waitForURL(/\/pl\/app\/calendar/);
  await owner.getByRole('link', { name: 'Happy hours' }).first().click();
  await expect(owner.getByRole('heading', { name: 'Happy hours' })).toBeVisible();
  await expect(owner.getByText('−20% · Codziennie · 08:00–12:00')).toBeVisible();
  await expect(owner.getByText('Specjaliści: Kasia')).toBeVisible();
  await expect(owner.getByText('Usługi: wszystkie')).toBeVisible();
  await owner.getByRole('button', { name: '+ Dodaj tańsze godziny' }).click();
  const sheet = owner.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(sheet.getByText('Wybierz co najmniej jeden dzień.')).toBeVisible();
  await sheet.getByLabel('Wtorek').check();
  await sheet.getByLabel('Od', { exact: true }).fill('14:00');
  await sheet.getByLabel(/^Do \(/).fill('16:00');
  await sheet.getByLabel('Rabat, %').fill('15');
  await sheet.getByLabel('Strzyżenie męskie').check();
  await shot(owner, '76b-owner-happy-hours-form');
  await sheet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(owner.getByText('Zapisano tańsze godziny.')).toBeVisible();
  await expect(owner.getByText('−15% · wt. · 14:00–16:00')).toBeVisible();
  await expect(owner.getByText('Usługi: Strzyżenie męskie')).toBeVisible();
  await shot(owner, '76c-owner-happy-hours');
  await owner.getByRole('button', { name: 'Usuń tańsze godziny 2' }).click();
  await owner.getByRole('button', { name: 'Tak, usuń' }).click();
  await expect(owner.getByText('Usunięto tańsze godziny.')).toBeVisible();
  await expect(owner.getByText('−15% · wt. · 14:00–16:00')).toHaveCount(0);
  await expect(owner.getByText('−20% · Codziennie · 08:00–12:00')).toBeVisible();
  await desk.close();
});
