import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Task 16: the salon's happy hours. The owner sets −20% at Kasia's (via the API for now); the
 * client sees "−20%" at the free times and the lower price on the held visit. Screenshots 76, 76a.
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
});
