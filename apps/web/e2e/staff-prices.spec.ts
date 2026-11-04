import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Task 62, part 3: each specialist's own price as the client sees it. Kasia cuts for 75 zł,
 * Marek for the service's 90 zł: the price list says "od 75,00 zł", the specialist step shows
 * each one's price ("Dowolny specjalista — od 75,00 zł"), and the held visit costs Kasia's
 * price. A service with one price stays "90,00 zł". Screenshots 82, 82a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `prices-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithStaffPrices(api: APIRequestContext): Promise<string> {
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
    await api.post('/v1/organizations', { headers: owner, data: { name: 'Cena Barber' } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Cena Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Prywatność\n\nAdministratorem danych jest Cena Barber.',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const haircut = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const beard = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Broda', durationMinutes: 30, priceGrosze: 6000 },
    }),
  );
  for (const name of ['Kasia', 'Marek']) {
    const staff = await json<{ id: string }>(
      await api.post(`${base}/staff`, {
        headers: owner,
        data: { displayName: name, serviceIds: [haircut.id, beard.id] },
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
    if (name === 'Kasia') {
      await json(
        await api.put(`${base}/services/${haircut.id}/staff-prices`, {
          headers: owner,
          data: { prices: [{ staffId: staff.id, priceGrosze: 7500 }] },
        }),
      );
    }
  }
  return location.slug;
}

test("the client sees 'od' on the price list and each specialist's price", async ({
  browser,
  request,
}) => {
  const slug = await salonWithStaffPrices(request);
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.82' },
  });
  const client = await phone.newPage();
  await client.goto(`/pl/b/${slug}`);
  const haircut = client.getByRole('button', { name: /Strzyżenie męskie/ });
  await expect(haircut).toContainText('od 75,00');
  // One price for everyone: no "od".
  const beard = client.getByRole('button', { name: /Broda/ });
  await expect(beard).toContainText('60,00');
  await expect(beard).not.toContainText('od ');
  await shot(client, '82-booking-price-from');

  await haircut.click();
  await expect(client.getByRole('button', { name: /Dowolny specjalista/ })).toContainText(
    'od 75,00',
  );
  await expect(client.getByRole('button', { name: /Kasia/ })).toContainText('75,00');
  await expect(client.getByRole('button', { name: /Marek/ })).toContainText('90,00');
  await shot(client, '82a-booking-staff-prices');

  // Kasia's visit costs her price.
  await client.getByRole('button', { name: /Kasia/ }).click();
  await client.locator('.day-strip button').nth(1).click();
  await client.locator('.times button').first().click();
  await expect(client.locator('.summary')).toContainText('75,00');
  await phone.close();
});
